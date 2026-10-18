/* A script-free same-origin frame gives native editing its own keyboard event path.
 * Page capture listeners cannot receive these events through shadow-DOM retargeting.
 */
(() => {
  const create = ({ onInput, onEscape }) => {
    const frame = document.createElement('iframe');
    frame.title = 'Document Note';
    frame.setAttribute('sandbox', 'allow-same-origin');
    let field, editorDocument, value = '', theme = 'light', composing = false, escapePending = false;
    const applyTheme = () => {
      if (!editorDocument) return;
      const dark = theme === 'dark';
      editorDocument.documentElement.style.colorScheme = theme;
      Object.assign(editorDocument.body.style, { background: dark ? '#1b1c20' : '#ffffff', color: dark ? '#f1f3f4' : '#202124' });
      field.style.setProperty('--editor-focus', dark ? '#e8ba62' : '#8a5b00');
    };
    const mount = () => {
      const doc = frame.contentDocument;
      if (!doc?.body || doc === editorDocument) return;
      editorDocument = doc;
      const style = doc.createElement('style');
      style.textContent = 'html,body{height:100%;margin:0}textarea{display:block;box-sizing:border-box;width:100%;height:100%;margin:0;border:0;resize:none;padding:10px;background:transparent;color:inherit;font:14px/1.6 "YouTube Sans",Roboto,sans-serif}textarea:focus-visible{outline:2px solid var(--editor-focus);outline-offset:-2px}';
      doc.head.append(style);
      field = doc.createElement('textarea');
      field.setAttribute('aria-label', 'Document Note');
      field.placeholder = 'Add a thought about this video…';
      field.value = value;
      doc.body.replaceChildren(field);
      field.addEventListener('input', () => { value = field.value; onInput(value); });
      field.addEventListener('compositionstart', () => { composing = true; });
      field.addEventListener('compositionend', () => { composing = false; });
      doc.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !event.isComposing && !composing) {
          event.preventDefault();
          escapePending = true;
        }
      });
      doc.addEventListener('keyup', event => {
        if (event.key === 'Escape' && escapePending) {
          event.preventDefault();
          escapePending = false;
          onEscape();
        }
      });
      frame.contentWindow.addEventListener('blur', () => { escapePending = false; });
      applyTheme();
    };
    frame.addEventListener('load', mount);
    return { frame, mount,
      setTheme(next) { theme = next; applyTheme(); },
      get value() { return field?.value ?? value; },
      set value(next) { value = next; if (field && field.value !== next) field.value = next; }
    };
  };
  globalThis.MVSReaderEditor = { create };
})();
