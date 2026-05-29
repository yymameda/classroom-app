# -*- coding: utf-8 -*-
import io
p = 'index.html'
s = io.open(p, encoding='utf-8').read()

edits = []

# ---- Edit 1: expose kentei helpers on window (inside RECORDS IIFE) ----
old1 = """            for (var i = 0; i < idx; i++) {
                var prev = config.categories[i];
                var cnt = prev.skills.filter(function(s) { return passData[s.id] === 1; }).length;
                if (cnt < prev.skills.length) return true;
            }
            return false;
        }
        // ============================================================
        // KenteiCard 共通モジュール ここまで"""
new1 = """            for (var i = 0; i < idx; i++) {
                var prev = config.categories[i];
                var cnt = prev.skills.filter(function(s) { return passData[s.id] === 1; }).length;
                if (cnt < prev.skills.length) return true;
            }
            return false;
        }

        // 監査診断モジュール(別IIFE)から参照できるよう公開(単一の真実のソースを再利用)
        window.kenteiGetConfig      = kenteiGetConfig;
        window.kenteiTotalSkills    = kenteiTotalSkills;
        window.kenteiCalcStage      = kenteiCalcStage;
        window.kenteiStageToScore10 = kenteiStageToScore10;
        window.kenteiGetPresetId    = kenteiGetPresetId;
        // ============================================================
        // KenteiCard 共通モジュール ここまで"""
edits.append(('E1 expose kentei on window', old1, new1))

# ---- Edit 2: new collector checkKenteiIntegrity() after collectMigrationFlags ----
old2 = """            return { flags: flags };
        }

        function collectAnomalies(result) {"""
new2 = """            return { flags: flags };
        }

        function checkKenteiIntegrity() {
            var kGetConfig   = window.kenteiGetConfig;
            var kTotalSkills = window.kenteiTotalSkills;
            var kCalcStage   = window.kenteiCalcStage;
            var kStageScore  = window.kenteiStageToScore10;
            var kGetPreset   = window.kenteiGetPresetId;
            var available = (typeof kGetConfig === 'function' && typeof kTotalSkills === 'function' &&
                             typeof kCalcStage === 'function' && typeof kStageScore === 'function');
            if (!available) {
                return { available: false, kenteiTestCount: 0, scoreTotal: 0,
                         missingStage: 0, missingScore10: 0, missingPassData: 0,
                         stageOutOfRange: 0, stageMismatch: 0, score10Mismatch: 0,
                         configIssues: [], perTest: [], samples: [],
                         migrationDone: false, migrationInfo: null };
            }

            var tests  = StorageManager.get(KEYS.tests, []);
            var scores = StorageManager.get(KEYS.scores, []);

            var kenteiTestMap = {};
            var perTest = [];
            var configIssues = [];

            tests.forEach(function(t) {
                var config = kGetConfig(t);
                if (!config) return;
                kenteiTestMap[t.id] = config;

                var totalSkills = kTotalSkills(config);
                var ctRows   = (config.conversionTable || []).length;
                var catCount = (config.categories || []).length;
                var presetId = config.presetId || config._presetId ||
                               (typeof kGetPreset === 'function' ? kGetPreset(t.peUnit) : null) || '(不明)';

                var expectedSkills = null;
                if (presetId === 'nawatobi') expectedSkills = 21;
                else if (presetId === 'swimming') expectedSkills = 24;

                var issues = [];
                if (catCount === 0)    issues.push('カテゴリ0');
                if (totalSkills === 0) issues.push('技数0');
                if (expectedSkills !== null && totalSkills !== expectedSkills) {
                    issues.push('技数' + totalSkills + '(期待' + expectedSkills + ')');
                }
                if (ctRows !== totalSkills + 1) {
                    issues.push('換算表' + ctRows + '行(期待' + (totalSkills + 1) + ')');
                }
                if (issues.length > 0) {
                    configIssues.push({ testId: t.id, name: t.name || '', presetId: presetId, issues: issues });
                }

                perTest.push({ testId: t.id, name: t.name || '', presetId: presetId,
                               totalSkills: totalSkills, ctRows: ctRows });
            });

            var scoreTotal = 0;
            var missingStage = 0, missingScore10 = 0, missingPassData = 0;
            var stageOutOfRange = 0, stageMismatch = 0, score10Mismatch = 0;
            var samples = [];

            scores.forEach(function(sc) {
                var config = kenteiTestMap[sc.testId];
                if (!config) return;
                scoreTotal++;

                var totalSkills = kTotalSkills(config);
                var hasStage   = (typeof sc.stage === 'number');
                var hasScore10 = (typeof sc.score10 === 'number');
                var pd         = sc.passData || sc.nawatobiData;
                var hasPass    = (pd && typeof pd === 'object');

                if (!hasStage)   missingStage++;
                if (!hasScore10) missingScore10++;
                if (!hasPass)    missingPassData++;

                if (hasStage && (sc.stage < 0 || sc.stage > totalSkills)) {
                    stageOutOfRange++;
                    if (samples.length < 5) samples.push('testId=' + sc.testId + ' 児童#' + sc.studentIndex + ': stage=' + sc.stage + ' が範囲外(0〜' + totalSkills + ')');
                }
                if (hasStage && hasPass) {
                    var recalc = kCalcStage(config, pd);
                    if (recalc !== sc.stage) {
                        stageMismatch++;
                        if (samples.length < 5) samples.push('testId=' + sc.testId + ' 児童#' + sc.studentIndex + ': stage=' + sc.stage + ' / passData再計算=' + recalc);
                    }
                }
                if (hasStage && hasScore10) {
                    var expected10 = kStageScore(config, sc.stage);
                    if (expected10 !== null && Math.abs(expected10 - sc.score10) > 0.001) {
                        score10Mismatch++;
                        if (samples.length < 5) samples.push('testId=' + sc.testId + ' 児童#' + sc.studentIndex + ': score10=' + sc.score10 + ' / 換算表=' + expected10);
                    }
                }
            });

            var rawFlag = (StorageManager.getRaw ? StorageManager.getRaw('migration_kenteiCard_v1')
                                                 : localStorage.getItem('migration_kenteiCard_v1'));
            var migrationDone = !!rawFlag;
            var migrationInfo = null;
            if (rawFlag) {
                try { migrationInfo = JSON.parse(rawFlag); } catch (e) { migrationInfo = { raw: String(rawFlag) }; }
            }

            return {
                available:       true,
                kenteiTestCount: perTest.length,
                perTest:         perTest,
                configIssues:    configIssues,
                scoreTotal:      scoreTotal,
                missingStage:    missingStage,
                missingScore10:  missingScore10,
                missingPassData: missingPassData,
                stageOutOfRange: stageOutOfRange,
                stageMismatch:   stageMismatch,
                score10Mismatch: score10Mismatch,
                samples:         samples,
                migrationDone:   migrationDone,
                migrationInfo:   migrationInfo
            };
        }

        function collectAnomalies(result) {"""
edits.append(('E2 checkKenteiIntegrity collector', old2, new2))

# ---- Edit 3: assembler ----
old3 = """                        answersFormat:       analyzeAnswersFormat(),
                        migrationFlags:      collectMigrationFlags()
                    };"""
new3 = """                        answersFormat:       analyzeAnswersFormat(),
                        migrationFlags:      collectMigrationFlags(),
                        kenteiIntegrity:     checkKenteiIntegrity()
                    };"""
edits.append(('E3 assembler', old3, new3))

# ---- Edit 4: anomaly rules ----
old4 = """            var overallStatus;
            if (critical.length > 0) {"""
new4 = """            // --- 検定カードの整合性 ---
            var ki = result.kenteiIntegrity;
            if (ki && ki.available) {
                if (ki.stageMismatch > 0) {
                    critical.push('検定カード: stage が passData と不整合 ' + ki.stageMismatch + '件(評価点に直接影響)');
                }
                if (ki.score10Mismatch > 0) {
                    critical.push('検定カード: score10 が換算表と不整合 ' + ki.score10Mismatch + '件(換算表編集後の再計算漏れの可能性)');
                }
                if (ki.stageOutOfRange > 0) {
                    critical.push('検定カード: stage が範囲外 ' + ki.stageOutOfRange + '件');
                }
                if (ki.configIssues.length > 0) {
                    warn.push('検定カード: kenteiConfig 異常(技数/換算表行数) ' + ki.configIssues.length + '件のテスト');
                }
                if (ki.kenteiTestCount > 0 && !ki.migrationDone) {
                    warn.push('検定カードがあるのにマイグレーション未完了(migration_kenteiCard_v1 なし)');
                }
                if (ki.missingStage > 0 || ki.missingScore10 > 0) {
                    warn.push('検定カードスコアで stage/score10 未設定 ' + Math.max(ki.missingStage, ki.missingScore10) + '件(未正規化)');
                }
            }

            var overallStatus;
            if (critical.length > 0) {"""
edits.append(('E4 anomaly rules', old4, new4))

# ---- Edit 5a: render destructuring ----
old5a = """            var mf = result.migrationFlags;
            var an = result.anomalies;"""
new5a = """            var mf = result.migrationFlags;
            var ki = result.kenteiIntegrity;
            var an = result.anomalies;"""
edits.append(('E5a render destructure', old5a, new5a))

# ---- Edit 5b: render section 10 (kentei) + renumber anomalies 9->10 ----
old5b = """            html += '<div class=\"audit-result-subsection\">';
            html += '<h4>9. 異常検出サマリー</h4>';"""
new5b = """            // 9. 検定カードの整合性
            html += '<div class=\"audit-result-subsection\">';
            html += '<h4>9. 検定カードの整合性</h4>';
            if (!ki || !ki.available) {
                html += '<p>検定カード共通モジュールが参照できないため、この項目はスキップされました。</p>';
            } else if (ki.kenteiTestCount === 0) {
                html += '<p>検定カード型のテストはありません。</p>';
            } else {
                html += '<table class=\"audit-table\">';
                html += _aRow('検定カードのテスト数', ki.kenteiTestCount + '件');
                html += _aRow('検定カードのスコア数', ki.scoreTotal + '件');
                html += _aRow('マイグレーション', ki.migrationDone
                    ? '✅ 完了' + (ki.migrationInfo && typeof ki.migrationInfo.count === 'number' ? '(' + ki.migrationInfo.count + '件正規化)' : '')
                    : '⚠️ 未実施');
                html += _aRow('stage 範囲外',          _sts(ki.stageOutOfRange === 0) + ' ' + ki.stageOutOfRange + '件');
                html += _aRow('stage⇔passData 不整合', _sts(ki.stageMismatch === 0) + ' ' + ki.stageMismatch + '件');
                html += _aRow('score10⇔換算表 不整合', _sts(ki.score10Mismatch === 0) + ' ' + ki.score10Mismatch + '件');
                html += _aRow('stage/score10 未設定',  (ki.missingStage + ki.missingScore10 === 0) ? '0件' : ('stage:' + ki.missingStage + ' / score10:' + ki.missingScore10 + '件'));
                html += '</table>';

                if (ki.perTest.length > 0) {
                    html += '<details class=\"audit-detail-block\"><summary>テスト別構成</summary><div class=\"audit-detail-body\">';
                    ki.perTest.forEach(function(p) {
                        var bad = ki.configIssues.some(function(c) { return c.testId === p.testId; });
                        html += (bad ? '⚠️ ' : '') + escapeHtml(p.name || '(無題)') + ' [' + escapeHtml(p.presetId) + '] 技数:' + p.totalSkills + ' 換算表:' + p.ctRows + '行<br>';
                    });
                    html += '</div></details>';
                }
                if (ki.configIssues.length > 0) {
                    html += '<details class=\"audit-detail-block\"><summary>kenteiConfig 異常 ' + ki.configIssues.length + '件</summary><div class=\"audit-detail-body\">';
                    ki.configIssues.forEach(function(c) {
                        html += escapeHtml(c.name || '(無題)') + ': ' + escapeHtml(c.issues.join(', ')) + '<br>';
                    });
                    html += '</div></details>';
                }
                if (ki.samples.length > 0) {
                    html += '<details class=\"audit-detail-block\"><summary>不整合サンプル(最大5件)</summary><div class=\"audit-detail-body\">';
                    ki.samples.forEach(function(smp) { html += escapeHtml(smp) + '<br>'; });
                    html += '</div></details>';
                }
            }
            html += '</div>';

            html += '<div class=\"audit-result-subsection\">';
            html += '<h4>10. 異常検出サマリー</h4>';"""
edits.append(('E5b render section + renumber', old5b, new5b))

# ---- Edit 6a: text export destructuring ----
old6a = """            var ss = r.submissionStatus, af = r.answersFormat, an = r.anomalies;"""
new6a = """            var ss = r.submissionStatus, af = r.answersFormat, an = r.anomalies;
            var ki = r.kenteiIntegrity;"""
edits.append(('E6a text destructure', old6a, new6a))

# ---- Edit 6b: text export section ----
old6b = """            lines.push('【異常検出サマリー】');"""
new6b = """            if (ki && ki.available && ki.kenteiTestCount > 0) {
                lines.push('【検定カードの整合性】');
                lines.push('検定カードのテスト数: ' + ki.kenteiTestCount + '件');
                lines.push('検定カードのスコア数: ' + ki.scoreTotal + '件');
                lines.push('マイグレーション: ' + (ki.migrationDone ? ('完了' + (ki.migrationInfo && typeof ki.migrationInfo.count === 'number' ? '(' + ki.migrationInfo.count + '件正規化)' : '')) : '未実施'));
                lines.push('stage 範囲外: ' + ki.stageOutOfRange + '件');
                lines.push('stage⇔passData 不整合: ' + ki.stageMismatch + '件');
                lines.push('score10⇔換算表 不整合: ' + ki.score10Mismatch + '件');
                lines.push('stage/score10 未設定: stage:' + ki.missingStage + ' / score10:' + ki.missingScore10 + '件');
                ki.configIssues.forEach(function(c) { lines.push('  config異常 ' + (c.name || '(無題)') + ': ' + c.issues.join(', ')); });
                lines.push('');
            }

            lines.push('【異常検出サマリー】');"""
edits.append(('E6b text section', old6b, new6b))

# Apply with assertions
for name, old, new in edits:
    cnt = s.count(old)
    if cnt != 1:
        raise SystemExit('FAIL anchor [%s] count=%d (must be 1)' % (name, cnt))
    s = s.replace(old, new, 1)
    print('OK  ', name)

io.open(p, 'w', encoding='utf-8').write(s)
print('--- all edits applied ---')
