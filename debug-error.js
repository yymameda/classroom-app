window.__errs = [];
window.addEventListener('error', function(e) {
    window.__errs.push((e.message || '') + ' @ ' + ((e.filename || '').split('/').pop()) + ':' + e.lineno);
    var d = document.getElementById('__errbox');
    if (!d) {
        d = document.createElement('div');
        d.id = '__errbox';
        d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:999999;background:#b00;color:#fff;font-size:11px;padding:8px;white-space:pre-wrap;max-height:40vh;overflow:auto;';
        document.body.appendChild(d);
    }
    d.textContent = 'ERR(' + window.__errs.length + '):\n' + window.__errs.join('\n');
});
