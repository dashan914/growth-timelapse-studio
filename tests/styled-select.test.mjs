import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initializeStyledSelects, StyledSelect} from '../src/styled-select.js';

// A small DOM harness exercises native-property forwarding and actual component
// events. No renderer, model fixture or browser package is required.
class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) { const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback)); }
  dispatchEvent(event) { event.target ||= this; for (const callback of this.listeners.get(event.type) || []) callback(event); return true; }
}
class Element extends Target {
  constructor(document, tag) {
    super(); this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.dataset = {}; this.style = {}; this.tabIndex = 0;
    this.classList = {add: value => this.attributes.set('class', value), remove: () => this.attributes.delete('class')};
    this.rect = {left: 100, top: 100, bottom: 140, width: 200, height: 40};
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get htmlFor() { return this.getAttribute('for') || ''; }
  set htmlFor(value) { this.setAttribute('for', value); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { value ? this.setAttribute('hidden', '') : this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { value ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.replaceChildren(); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { const previous = this.getAttribute(name); this.attributes.set(name, String(value)); if (previous !== String(value)) this.ownerDocument.changed(this, 'attributes', name); }
  removeAttribute(name) { if (this.attributes.delete(name)) this.ownerDocument.changed(this, 'attributes', name); }
  append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } this.ownerDocument.changed(this, 'childList'); }
  after(child) { const parent = this.parentElement; child.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, child); }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  remove() { if (this.parentElement) { const parent = this.parentElement; parent.children = parent.children.filter(child => child !== this); this.parentElement = null; this.ownerDocument.changed(parent, 'childList'); } }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  querySelectorAll(selector) { const tags = selector.split(',').map(tag => tag.toUpperCase()); return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]); }
  cloneNode(deep) { const copy = new Element(this.ownerDocument, this.tagName); copy.text = this.text; copy.attributes = new Map(this.attributes); if (deep) copy.append(...this.children.map(child => child.cloneNode(true))); return copy; }
  getClientRects() { for (let element = this; element; element = element.parentElement) if (element.hidden || (element.tagName === 'DETAILS' && !element.hasAttribute('open'))) return []; return this.ownerDocument.body.contains(this) ? [this.rect] : []; }
  getBoundingClientRect() { return this.tagName === 'DIV' && this.getAttribute('role') === 'listbox' ? {...this.rect, height: Math.min(this.scrollHeight, parseFloat(this.style.maxHeight) || Infinity)} : this.rect; }
  get scrollHeight() { return this.children.length * 40 + 10; }
  scrollIntoView() { this.revealed = true; }
  focus() { this.ownerDocument.activeElement = this; }
}
class Select extends Element {
  constructor(document) { super(document, 'select'); this.index = 0; this.labels = []; }
  get options() { return this.querySelectorAll('option'); }
  get selectedIndex() { return this.options.length ? this.index : -1; }
  set selectedIndex(value) { this.index = Number(value); }
  get value() { return this.options[this.selectedIndex]?.value || ''; }
  set value(value) { this.selectedIndex = this.options.findIndex(option => option.value === String(value)); }
}
class Option extends Element {
  constructor(document) { super(document, 'option'); }
  get index() { let select = this.parentElement; while (select && select.tagName !== 'SELECT') select = select.parentElement; return select?.options.indexOf(this) ?? -1; }
  get selected() { let select = this.parentElement; while (select && select.tagName !== 'SELECT') select = select.parentElement; return select?.selectedIndex === this.index; }
}
function harness() {
  const window = new Target(); window.innerWidth = 1000; window.innerHeight = 720; window.Event = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  const document = new Target(); document.defaultView = window; document.observers = [];
  document.createElement = tag => tag === 'select' ? new Select(document) : tag === 'option' ? new Option(document) : new Element(document, tag);
  document.createElementNS = (_, tag) => document.createElement(tag);
  document.body = new Element(document, 'body'); document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.getElementById = id => [document.body, ...document.body.querySelectorAll('select,button,span,svg,div,label,details,option,optgroup')].find(element => element.id === id) || null;
  document.changed = (target, type, name) => { for (const observer of document.observers) if (observer.targets.some(entry => (entry.target === target || entry.options.subtree && entry.target.contains(target)) && entry.options[type] && (!entry.options.attributeFilter || entry.options.attributeFilter.includes(name)))) observer.pending = true; };
  document.flush = () => { for (const observer of document.observers) if (observer.pending) { observer.pending = false; observer.callback(); } };
  window.MutationObserver = class { constructor(callback) { this.callback = callback; this.targets = []; document.observers.push(this); } observe(target, options) { this.targets.push({target, options}); } disconnect() { this.targets = []; } };
  function field(id, values = ['left', 'right', 'front'], parent = document.body) {
    const select = document.createElement('select'); select.id = id;
    for (const value of values) { const option = document.createElement('option'); option.value = value; option.textContent = value; select.append(option); }
    parent.append(select); return select;
  }
  return {document, window, field};
}
function press(control, value) { const event = {type: 'keydown', key: value, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }}; control.button.dispatchEvent(event); return event; }

test('initializes every public select, including closed/conditional panels, and remains idempotent', () => {
  const {document, field} = harness();
  field('ratio'); field('resolution'); field('export-quality'); field('format'); field('surface-preset');
  const popup = document.createElement('div'); popup.hidden = true; document.body.append(popup); field('canvas-light-direction', undefined, popup);
  const details = document.createElement('details'); details.hidden = true; document.body.append(details); field('source-unit', undefined, details);
  field('fps', undefined, details); field('bed-size-preset', undefined, popup); field('calibration-handle-select', [], popup);
  const appearance = field('output-appearance'); appearance.hidden = true; appearance.setAttribute('aria-hidden', 'true');
  const internal = field('light-direction'); internal.setAttribute('data-native-select', '');
  const first = initializeStyledSelects(document); first[0].select.hidden = true; const second = initializeStyledSelects(document);
  assert.equal(first.length, 10); assert.deepEqual(second, first); assert.equal(document.body.querySelectorAll('button').length, 10);
  assert.equal(appearance.classList ? appearance.getAttribute('class') : null, null); assert.equal(internal.getAttribute('class'), null);
});

test('visible value and availability follow direct native-property writes, without synthetic change events', () => {
  const {field} = harness(), select = field('ratio'); const control = new StyledSelect(select); let changes = 0; select.addEventListener('change', () => changes++);
  select.value = 'right'; assert.equal(control.text.textContent, 'right');
  select.selectedIndex = 2; assert.equal(control.text.textContent, 'front');
  control.open(); select.disabled = true; assert.equal(control.button.disabled, true); assert.equal(control.menu.hidden, true);
  select.disabled = false; select.hidden = true; assert.equal(control.button.hidden, true); select.hidden = false; assert.equal(control.button.hidden, false);
  assert.equal(changes, 0);
});

test('choosing an enabled option preserves input/change ordering and the native backing select', () => {
  const {field} = harness(), select = field('format'), control = new StyledSelect(select), events = [];
  for (const name of ['input', 'change']) select.addEventListener(name, event => events.push([event.type, event.bubbles, select.value]));
  control.open(); control.menu.children[1].dispatchEvent({type: 'click'});
  assert.equal(select.value, 'right'); assert.equal(control.text.textContent, 'right'); assert.equal(control.menu.hidden, true);
  assert.deepEqual(events, [['input', true, 'right'], ['change', true, 'right']]);
  control.open(); control.menu.children[1].dispatchEvent({type: 'click'}); assert.equal(events.length, 2);
});

test('separate labels retain labelledby and nested labels get a stable name independent of values', () => {
  const {document, field} = harness();
  const label = document.createElement('label'); label.textContent = '比例'; document.body.append(label); const ratio = field('ratio'); label.htmlFor = 'ratio'; ratio.labels = [label];
  const ratioControl = new StyledSelect(ratio); assert.equal(ratioControl.button.getAttribute('aria-labelledby'), label.id); assert.equal(label.htmlFor, ratioControl.button.id);
  const nested = document.createElement('label'); nested.textContent = '平面参考尺寸'; document.body.append(nested); const bed = field('bed-size-preset', ['H2C', 'P1S'], nested); bed.labels = [nested];
  const bedControl = new StyledSelect(bed); assert.equal(bedControl.button.getAttribute('aria-label'), '平面参考尺寸'); assert.equal(bedControl.menu.getAttribute('aria-label'), '平面参考尺寸');
  bed.value = 'P1S'; assert.equal(bedControl.button.getAttribute('aria-label'), '平面参考尺寸');
  const handle = field('calibration-handle-select', ['A', 'B'], nested); handle.labels = [nested]; handle.setAttribute('aria-label', '选择要微调的角点或竖线端点');
  const handleControl = new StyledSelect(handle); assert.equal(handleControl.button.getAttribute('aria-label'), '选择要微调的角点或竖线端点');
});

test('keyboard skips hidden/disabled options, blocks scene shortcuts and commits through native events', () => {
  const {field} = harness(), select = field('fps', ['24', '30', '60', '120']), control = new StyledSelect(select);
  select.options[1].hidden = true; select.options[2].disabled = true;
  const home = press(control, 'Home'); assert.equal(home.stopped, true); assert.equal(home.prevented, true); assert.equal(control.active, 0);
  press(control, 'ArrowDown'); assert.equal(control.active, 3); press(control, 'Enter'); assert.equal(select.value, '120'); assert.equal(control.menu.hidden, true);
  const letter = press(control, 'r'); assert.equal(letter.stopped, true); assert.equal(letter.prevented, true);
});

test('Escape closes only an open menu and then bubbles for parent editor cancellation; Tab leaves focus normally', () => {
  const {field} = harness(), control = new StyledSelect(field('bed-size-preset'));
  control.open(); const first = press(control, 'Escape'); assert.equal(first.stopped, true); assert.equal(control.menu.hidden, true);
  const second = press(control, 'Escape'); assert.equal(second.stopped, undefined); assert.equal(second.prevented, undefined);
  control.open(); const tab = press(control, 'Tab'); assert.equal(control.menu.hidden, true); assert.equal(tab.prevented, undefined);
});

test('dynamic options redraw and reposition open menus, close empty lists, and keep hidden options absent', () => {
  const {document, field} = harness(), select = field('calibration-handle-select'), control = new StyledSelect(select);
  control.button.rect = {left: 850, top: 640, bottom: 680, width: 200, height: 40}; control.open();
  assert.equal(control.menu.style.left, '790px'); assert.ok(parseFloat(control.menu.style.top) < 640);
  select.options[0].hidden = true; document.flush(); assert.equal(control.menu.children.length, 2); assert.equal(control.active, 1);
  select.replaceChildren(); document.flush(); assert.equal(control.menu.hidden, true);
  const option = document.createElement('option'); option.value = 'new'; option.textContent = '新增角点'; select.append(option); select.value = 'new'; document.flush();
  control.open(); assert.equal(control.menu.children.length, 1); assert.equal(control.text.textContent, '新增角点');
});

test('hidden parent editors close their portal menus, and only one listbox can be open', () => {
  const {document, field} = harness(), popup = document.createElement('div'); document.body.append(popup);
  const first = new StyledSelect(field('canvas-light-direction', undefined, popup)), second = new StyledSelect(field('ratio'));
  first.open(); second.open(); assert.equal(first.menu.hidden, true); assert.equal(second.menu.hidden, false);
  first.open(); popup.hidden = true; document.flush(); assert.equal(first.menu.hidden, true); first.open(); assert.equal(first.menu.hidden, true);
});

test('dispose restores the native select and lets initialization register it again', () => {
  const {document, field} = harness(), select = field('ratio'), control = new StyledSelect(select);
  select.value = 'right'; control.dispose(); control.dispose();
  assert.equal(document.body.querySelectorAll('button').length, 0); assert.equal(select.getAttribute('aria-hidden'), null); assert.equal(select.tabIndex, 0);
  for (const name of ['value', 'selectedIndex', 'disabled', 'hidden']) assert.equal(Object.hasOwn(select, name), false);
  assert.equal(select.value, 'right'); const [restored] = initializeStyledSelects(document); assert.notEqual(restored, control); assert.equal(restored.text.textContent, 'right');
});

test('the actual page declares the full public dropdown inventory and explicitly keeps internal selects hidden', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const selects = [...html.matchAll(/<select\b([^>]*)>/g)].map(([, attributes]) => ({id: attributes.match(/\bid="([^"]+)"/)?.[1], attributes}));
  assert.deepEqual(selects.map(item => item.id).sort(), ['camera-motion', 'source-unit', 'canvas-light-direction', 'ratio', 'resolution', 'export-quality', 'format', 'surface-preset', 'output-appearance', 'fps', 'light-direction', 'bed-size-preset', 'calibration-handle-select'].sort());
  assert.match(selects.find(item => item.id === 'output-appearance').attributes, /hidden/);
  assert.match(selects.find(item => item.id === 'output-appearance').attributes, /aria-hidden="true"/);
  assert.match(selects.find(item => item.id === 'light-direction').attributes, /data-native-select/);
});
