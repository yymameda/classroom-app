window.addEventListener('error', function(e) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:999999;background:#b00;color:#fff;font-size:12px;padding:8px;white-space:pre-wrap;word-break:break-all;';
    d.textContent = 'ERR: ' + (e.message || '') + '\n@ ' + ((e.filename || '').split('/').pop()) + ':' + e.lineno + ':' + e.colno;
    document.body.appendChild(d);
});
