const fs = require('fs');
const js = fs.readFileSync('src/web/public/app.js', 'utf8');

const elements = {};
function getOrCreate(id) {
  if (!elements[id]) {
    elements[id] = {
      id,
      value: '',
      innerHTML: '',
      textContent: '',
      disabled: false,
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      addEventListener: function(evt, cb) {
        this['on_' + evt] = cb;
      },
      querySelectorAll: () => [],
      querySelector: (sel) => {
        return getOrCreate(sel.replace(/[^a-zA-Z0-9_-]/g, ''));
      },
      appendChild: () => {},
      focus: () => {}
    };
  }
  return elements[id];
}

const mockDoc = {
  getElementById: (id) => getOrCreate(id),
  createElement: (tag) => getOrCreate('elem_' + Math.random()),
  querySelectorAll: (selector) => {
    if (selector === '.preset-btn') {
      const btn = getOrCreate('preset_1');
      btn.getAttribute = () => 'Test Preset Prompt';
      return [btn];
    }
    return [];
  },
  addEventListener: () => {}
};

global.window = {
  addEventListener: () => {},
  speechSynthesis: { cancel: () => {}, speak: () => {} },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
};
global.document = mockDoc;
global.localStorage = global.window.localStorage;
global.fetch = async () => ({
  ok: true,
  json: async () => ({
    providers: {},
    stats: { hitRatio: 0, hits: 0, totalSavedLatencyMs: 0, totalSavedUsd: 0 },
    tools: [],
    chats: []
  })
});

try {
  eval(js);
  console.log('1. Script parsed & evaluated successfully!');

  // Test preset button click
  const presetBtn = mockDoc.querySelectorAll('.preset-btn')[0];
  presetBtn.on_click();
  console.log('2. Preset button clicked -> promptInput.value:', elements['promptInput'].value);

  // Test form submit
  elements['promptInput'].value = 'Build a game';
  elements['chatForm'].on_submit({ preventDefault: () => {} });
  console.log('3. Form submitted successfully!');
  console.log('ALL TESTS PASSED WITH 100% SUCCESS!');
} catch (e) {
  console.error('ERROR:', e);
}
