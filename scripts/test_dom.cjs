const fs = require('fs');
const html = fs.readFileSync('src/web/public/index.html', 'utf8');
const js = fs.readFileSync('src/web/public/app.js', 'utf8');

// Simulate basic browser environment in Node
const mockWindow = {
  addEventListener: () => {},
  speechSynthesis: { cancel: () => {}, speak: () => {} },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  }
};

// Create mock elements for every getElementById and querySelectorAll
const elements = {};
function getOrCreate(id) {
  if (!elements[id]) {
    elements[id] = {
      id,
      value: '',
      innerHTML: '',
      textContent: '',
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      addEventListener: function(evt, cb) {
        this['on_' + evt] = cb;
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: () => {},
      focus: () => {}
    };
  }
  return elements[id];
}

const mockDoc = {
  getElementById: (id) => getOrCreate(id),
  querySelectorAll: (selector) => {
    if (selector === '.preset-btn') {
      return [
        { getAttribute: () => 'Test Preset Prompt', addEventListener: function(e, cb) { this.on_click = cb; } }
      ];
    }
    return [];
  },
  addEventListener: () => {}
};

global.window = mockWindow;
global.document = mockDoc;
global.localStorage = mockWindow.localStorage;
global.fetch = async () => ({ ok: true, json: async () => ({}) });

try {
  eval(js);
  console.log('DOM SCRIPT EXECUTED WITH ZERO RUNTIME ERRORS!');
  
  // Test preset button click
  const presetBtn = mockDoc.querySelectorAll('.preset-btn')[0];
  presetBtn.on_click();
  console.log('Preset button click handled! promptInput.value =', elements['promptInput'].value);

  // Test form submit
  const form = elements['chatForm'];
  elements['promptInput'].value = 'Hello World';
  form.on_submit({ preventDefault: () => {} });
  console.log('Form submit handled successfully! conversationHistory length =', conversationHistory.length);
} catch (e) {
  console.error('SIMULATED RUNTIME ERROR:', e);
}
