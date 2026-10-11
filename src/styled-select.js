const instances = new WeakMap();
const openMenus = new WeakMap();
let nextId = 0;

/** Enhance user-facing fields, including controls in initially closed panels. */
export function initializeStyledSelects(root = document) {
  return [...root.querySelectorAll('select')]
    .filter(select => instances.has(select) || (!select.hasAttribute('data-native-select') && !(select.hidden && select.getAttribute('aria-hidden') === 'true')))
    .map(select => instances.get(select) || new StyledSelect(select));
}

/** A compact dark listbox backed by the original select and its native events. */
export class StyledSelect {
  constructor(select) {
    if (instances.has(select)) return instances.get(select);
    this.select = select;
    this.document = select.ownerDocument;
    this.window = this.document.defaultView;
    this.listeners = [];
    this.originalProperties = new Map();
    const id = select.id || `styled-select-${++nextId}`;
    this.button = this.document.createElement('button');
    this.button.type = 'button';
    this.button.id = `${id}-trigger`;
    this.button.className = 'styled-select-trigger';
    this.button.setAttribute('role', 'combobox');
    this.button.setAttribute('aria-haspopup', 'listbox');
    this.button.setAttribute('aria-expanded', 'false');
    this.text = this.document.createElement('span');
    this.text.className = 'styled-select-value';
    this.button.append(this.text);
    const arrow = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 16 16');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<path d="m4 6 4 4 4-4"/>';
    this.button.append(arrow);
    this.menu = this.document.createElement('div');
    this.menu.id = `${id}-listbox`;
    this.menu.className = 'styled-select-menu';
    this.menu.setAttribute('role', 'listbox');
    this.menu.hidden = true;
    this.button.setAttribute('aria-controls', this.menu.id);
    this.label = select.labels?.[0];
    if (this.label) {
      this.originalLabelFor = this.label.htmlFor;
      this.originalLabelId = this.label.id;
      this.label.htmlFor = this.button.id;
    }
    const explicitName = select.getAttribute('aria-label');
    const explicitLabel = select.getAttribute('aria-labelledby');
    if (explicitName) this._name('aria-label', explicitName);
    else if (explicitLabel) this._name('aria-labelledby', explicitLabel);
    else if (this.label && !this.label.contains(select)) {
      this.label.id ||= `${id}-label`;
      this._name('aria-labelledby', this.label.id);
    } else {
      // An implicit label contains the live control. Referencing its whole text
      // would make the field's name change whenever the selected value changes.
      const labelCopy = this.label?.cloneNode(true);
      for (const control of labelCopy?.querySelectorAll('select,button,input,textarea,svg') || []) control.remove();
      this._name('aria-label', labelCopy?.textContent.trim().replace(/\s+/g, ' ') || '选择选项');
    }
    if (select.hasAttribute('aria-describedby')) this.button.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
    this.originalTabIndex = select.tabIndex;
    this.originalAriaHidden = select.getAttribute('aria-hidden');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.classList.add('styled-select-native');
    select.after(this.button);
    this.document.body.append(this.menu);
    // Model import, preset restoration and calibration update native properties
    // without events. Keep their visible value and availability in sync.
    for (const property of ['value', 'selectedIndex', 'disabled', 'hidden']) this._forwardProperty(property);
    this._listen(this.button, 'click', () => this.menu.hidden ? this.open() : this.close());
    this._listen(this.button, 'keydown', event => this._key(event));
    this._listen(select, 'input', () => this.sync());
    this._listen(select, 'change', () => this.sync());
    this._listen(this.button, 'blur', () => this.close());
    this._listen(this.document, 'pointerdown', event => {
      if (event.target !== this.button && !this.button.contains(event.target) && !this.menu.contains(event.target)) this.close();
    }, true);
    this._listen(this.window, 'resize', () => this.close());
    this._listen(this.document, 'scroll', event => { if (!this.menu.contains(event.target)) this.close(); }, true);
    this.observer = new this.window.MutationObserver(() => this.sync());
    this.observer.observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
    this.visibilityObserver = new this.window.MutationObserver(() => this.sync());
    // A listbox lives in body so it is not clipped by a scroll panel. Close it
    // if its original popup, details section or editor is hidden while open.
    for (let parent = select.parentElement; parent; parent = parent.parentElement) {
      this.visibilityObserver.observe(parent, { attributes: true, attributeFilter: ['hidden', 'open', 'style'] });
    }
    instances.set(select, this);
    this.sync();
  }

  _name(attribute, value) {
    this.button.setAttribute(attribute, value);
    this.menu.setAttribute(attribute, value);
  }
  _forwardProperty(name) {
    let prototype = Object.getPrototypeOf(this.select), property;
    while (prototype && !(property = Object.getOwnPropertyDescriptor(prototype, name))) prototype = Object.getPrototypeOf(prototype);
    if (!property?.get || !property?.set) return;
    this.originalProperties.set(name, Object.getOwnPropertyDescriptor(this.select, name));
    Object.defineProperty(this.select, name, { configurable: true, enumerable: property.enumerable,
      get: () => property.get.call(this.select),
      set: value => { property.set.call(this.select, value); this.sync(); } });
  }
  _listen(target, name, callback, options) {
    target.addEventListener(name, callback, options);
    this.listeners.push(() => target.removeEventListener(name, callback, options));
  }
  _enabled(option) {
    return Boolean(option && !option.hidden && !option.disabled && !option.parentElement?.disabled && !option.parentElement?.hidden);
  }
  _choices() { return [...this.select.options].filter(option => this._enabled(option)); }
  _visible() { return !this.button.hidden && this.button.getClientRects().length > 0; }
  sync() {
    const selected = this.select.options[this.select.selectedIndex];
    this.text.textContent = selected?.textContent || '选择选项';
    this.button.disabled = this.select.disabled;
    this.button.hidden = this.select.hidden;
    if (this.select.disabled || !this._visible() || !this._choices().length) this.close();
    else if (!this.menu.hidden) {
      if (!this._enabled(this.select.options[this.active])) this.active = this._enabled(selected) ? selected.index : this._choices()[0].index;
      this._draw();
      this._position();
      this._revealActive();
    }
  }
  _draw() {
    this.menu.replaceChildren();
    for (const option of this.select.options) {
      if (option.hidden || option.parentElement?.hidden) continue;
      const row = this.document.createElement('div');
      row.id = `${this.menu.id}-${option.index}`;
      row.className = 'styled-select-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.selected));
      row.setAttribute('aria-disabled', String(!this._enabled(option)));
      row.dataset.active = String(option.index === this.active);
      const text = this.document.createElement('span');
      text.textContent = option.textContent;
      row.append(text);
      const check = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      check.setAttribute('viewBox', '0 0 16 16');
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<path d="m3 8 3 3 7-7"/>';
      row.append(check);
      row.addEventListener('pointerdown', event => event.preventDefault());
      row.addEventListener('click', () => this._choose(option));
      this.menu.append(row);
    }
    const active = this.document.getElementById(`${this.menu.id}-${this.active}`);
    if (active) this.button.setAttribute('aria-activedescendant', active.id);
    else this.button.removeAttribute('aria-activedescendant');
  }
  open() {
    if (this.select.disabled || !this._visible() || !this._choices().length) return;
    openMenus.get(this.document)?.close();
    openMenus.set(this.document, this);
    this.active = this._enabled(this.select.options[this.select.selectedIndex]) ? this.select.selectedIndex : this._choices()[0].index;
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this._draw();
    this._position();
    this._revealActive();
  }
  _position() {
    const rect = this.button.getBoundingClientRect(), gap = 6, margin = 10;
    const width = Math.min(Math.max(rect.width, 180), Math.max(1, this.window.innerWidth - margin * 2));
    this.menu.style.width = `${width}px`;
    const roomBelow = this.window.innerHeight - rect.bottom - gap - margin, roomAbove = rect.top - gap - margin;
    const below = roomBelow >= Math.min(260, this.menu.scrollHeight) || roomBelow >= roomAbove;
    this.menu.style.maxHeight = `${Math.max(1, Math.min(260, below ? roomBelow : roomAbove))}px`;
    this.menu.style.left = `${Math.max(margin, Math.min(rect.left, this.window.innerWidth - width - margin))}px`;
    this.menu.style.top = `${below ? rect.bottom + gap : Math.max(margin, rect.top - gap - this.menu.getBoundingClientRect().height)}px`;
  }
  close() {
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.button.removeAttribute('aria-activedescendant');
    if (openMenus.get(this.document) === this) openMenus.delete(this.document);
  }
  _revealActive() {
    this.document.getElementById(`${this.menu.id}-${this.active}`)?.scrollIntoView({ block: 'nearest' });
  }
  _choose(option) {
    if (this.select.disabled || !this._enabled(option)) return;
    const changed = this.select.selectedIndex !== option.index;
    this.select.selectedIndex = option.index;
    this.sync();
    this.close();
    this.button.focus({ preventScroll: true });
    if (changed) for (const type of ['input', 'change']) this.select.dispatchEvent(new this.window.Event(type, { bubbles: true }));
  }
  _key(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'];
    if (event.key === 'Tab') { this.close(); return; }
    // Escape dismisses one layer: first the open menu, then its parent editor.
    if (event.key === 'Escape' && this.menu.hidden) return;
    if (!keys.includes(event.key) && event.key.length !== 1) return;
    // Keep the model's W/E/R/Home shortcuts out of a focused field.
    event.stopPropagation();
    event.preventDefault();
    if (event.key === 'Escape') { this.close(); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      if (this.menu.hidden) this.open();
      else this._choose(this.select.options[this.active]);
      return;
    }
    if (this.menu.hidden) this.open();
    const choices = this._choices();
    if (!choices.length) return;
    const current = Math.max(0, choices.findIndex(option => option.index === this.active));
    if (event.key === 'ArrowDown') this.active = choices[Math.min(current + 1, choices.length - 1)].index;
    else if (event.key === 'ArrowUp') this.active = choices[Math.max(0, current - 1)].index;
    else if (event.key === 'Home') this.active = choices[0].index;
    else if (event.key === 'End') this.active = choices.at(-1).index;
    else {
      const now = Date.now();
      this.search = now - (this.searchTime || 0) > 700 ? event.key : (this.search || '') + event.key;
      this.searchTime = now;
      const found = choices.find(option => option.textContent.trim().toLocaleLowerCase().startsWith(this.search.toLocaleLowerCase()));
      if (found) this.active = found.index;
    }
    this._draw();
    this._position();
    this._revealActive();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
    this.observer.disconnect();
    this.visibilityObserver.disconnect();
    for (const remove of this.listeners) remove();
    this.button.remove();
    this.menu.remove();
    this.select.classList.remove('styled-select-native');
    this.select.tabIndex = this.originalTabIndex;
    if (this.originalAriaHidden === null) this.select.removeAttribute('aria-hidden');
    else this.select.setAttribute('aria-hidden', this.originalAriaHidden);
    if (this.label) {
      this.label.htmlFor = this.originalLabelFor;
      this.label.id = this.originalLabelId;
    }
    for (const [name, original] of this.originalProperties) {
      if (original) Object.defineProperty(this.select, name, original);
      else delete this.select[name];
    }
    instances.delete(this.select);
  }
}
