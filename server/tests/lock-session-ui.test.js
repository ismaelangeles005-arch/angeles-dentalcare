const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
test('all eight tenant lock buttons reuse the shared logout class and stylesheet', () => {
    const pages = fs.readdirSync(root).filter(file => file.endsWith('.html')).filter(file => /<button\b[^>]*class="logout-btn"/.test(fs.readFileSync(path.join(root,file),'utf8')));
    assert.equal(pages.length, 8);
    for (const page of pages) {
        const html = fs.readFileSync(path.join(root,page),'utf8');
        assert(html.includes('href="styles.css"'), page);
        assert.match(html, /<button type="button" class="logout-btn"[^>]*>\s*Bloquear sesión\s*<\/button>/);
        assert(!/\.logout-btn\s*\{/.test(html), `${page}: local override`);
        assert.match(html, /<button\b[^>]*class="logout-btn"[^>]*onclick="(?:DentalRoles\.logout|cerrarSesion)\(\)"/);
    }
});
test('shared lock visual matches dashboard; notifications keep 42px and wrapping alignment', () => {
    const rule = css.match(/(?:^|\n)\.logout-btn\s*\{([^}]+)\}/)[1];
    for (const declaration of ['min-height: 42px','padding: 10px 16px','background: var(--color-error)','color: white','border-radius: var(--radius-md)','font-weight: 800']) assert(rule.includes(declaration));
    assert(css.includes('button:focus-visible'));
    assert(css.includes('.logout-btn:hover'));
    assert.match(css, /\.topbar-actions\s*\{[^}]*flex-wrap: wrap;[^}]*align-items: center;/);
    assert.match(css, /\.notification-center\s*\{[^}]*flex: 0 0 42px;/);
    assert.match(css, /\.notification-button\s*\{[^}]*width: 42px;[^}]*height: 42px;/);
});
