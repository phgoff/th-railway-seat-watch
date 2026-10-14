const fs = require('node:fs');
const vm = require('node:vm');

async function dashboard({
  saved = {},
  now = '2026-10-13T05:00:00Z',
  removeError,
  responses = {},
  handleMessage,
  scripts,
  signedIn = null,
  pathname = '/DTicketPublicWeb/home/Home',
} = {}) {
  let currentTime = Date.parse(now);
  const memory = structuredClone(saved);
  const messages = [],
    requests = [],
    timers = new Map(),
    storageListeners = [];
  const documentListeners = {},
    documentEvents = [];
  let timerId = 0;
  class Element {
    constructor(id = '') {
      Object.assign(this, {
        id,
        value: '',
        hidden: false,
        disabled: false,
        dataset: {},
        style: {},
        attributes: {},
        listeners: {},
      });
      const classes = new Set();
      this.classList = {
        add: (...values) => values.forEach((value) => classes.add(value)),
        remove: (...values) => values.forEach((value) => classes.delete(value)),
        contains: (value) => classes.has(value),
        toggle: (value, on = !classes.has(value)) => {
          on ? classes.add(value) : classes.delete(value);
        },
      };
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    setAttribute(key, value) {
      this.attributes[key] = String(value);
      if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
    }
    getAttribute(key) {
      return this.attributes[key];
    }
    toggleAttribute(key, on) {
      on ? this.setAttribute(key, '') : delete this.attributes[key];
    }
    querySelectorAll() {
      return [];
    }
    querySelector() {
      return null;
    }
    matches(selector) {
      return selector === '[data-chk-all]' && this === allTrains;
    }
    closest(selector) {
      const action = selector.match(/^\[data-action="([\w-]+)"\]$/)?.[1];
      return action && action === this.dataset.action ? this : null;
    }
    focus() {
      root.activeElement = this;
      this.emit('focus');
    }
    getBoundingClientRect() {
      return { left: 100, bottom: 100 };
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
      this.onclose?.();
    }
    emit(type) {
      const event = { target: this, currentTarget: this, preventDefault() {} };
      for (const fn of this.listeners[type] || []) fn(event);
      if (this !== root && ['click', 'change'].includes(type))
        for (const fn of root.listeners[type] || []) fn(event);
    }
    click() {
      if (!this.disabled) {
        this.onclick?.();
        this.emit('click');
      }
    }
  }
  const root = new Element();
  const authObservers = [],
    account = { value: signedIn ? 'signed-in' : '' },
    login = new Element();
  let loginClicks = 0;
  login.onclick = () => loginClicks++;
  const uiSource = fs.readFileSync('extension/ui.js', 'utf8');
  const uiContext = vm.createContext({});
  vm.runInContext(uiSource, uiContext);
  const ids = [...uiContext.RailWatchUI.markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const elements = Object.fromEntries(ids.map((id) => [id, new Element(id)]));
  const filters = ['1', '2', '3', 'sleep'].map((value) =>
    Object.assign(new Element(), { value, checked: true }),
  );
  elements.filter.querySelectorAll = (selector) =>
    selector === 'input:checked' ? filters.filter((input) => input.checked) : filters;
  const allTrains = Object.assign(new Element(), { checked: true });
  elements.alertsPanel.querySelector = () => allTrains;
  elements.interval.value = '900000';
  elements.alertsEnabled.value = 'off';
  elements.alertMinimum.value = '1';
  elements.shell.dataset = { theme: 'dark', accent: 'brass' };
  elements.shell.hidden = true;
  elements.shell.append = () => {};
  const palettes = ['brass', 'cyan', 'forest', 'plum'].map((value) =>
    Object.assign(new Element(), { dataset: { action: 'accent', val: value } }),
  );
  const cadences = ['5', '10', '15'].map((value) =>
    Object.assign(new Element(), { dataset: { action: 'cadence', val: value } }),
  );
  const dateLabels = { start: new Element(), end: new Element() };
  root.getElementById = (id) => elements[id];
  root.querySelectorAll = (selector) =>
    selector === '.palette-btn' ? palettes : selector === '[data-action="cadence"]' ? cadences : [];
  root.querySelector = (selector) =>
    selector.includes('data-dtxt')
      ? dateLabels[selector.includes('start') ? 'start' : 'end']
      : null;
  const runtime = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(
            keys.filter((key) => key in memory).map((key) => [key, structuredClone(memory[key])]),
          );
        },
        async set(values) {
          Object.assign(memory, structuredClone(values));
          for (const fn of storageListeners)
            fn(
              Object.fromEntries(
                Object.entries(values).map(([key, newValue]) => [key, { newValue }]),
              ),
              'local',
            );
        },
        async remove(key) {
          if (removeError) throw Error(removeError);
          delete memory[key];
        },
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        messages.push(structuredClone(message));
        return handleMessage ? handleMessage(message, runtime.storage.local) : { ok: true };
      },
    },
    async request(endpoint, params) {
      requests.push(endpoint);
      return {
        errorCode: 'S_SUCCESS',
        data:
          (await (typeof responses === 'function'
            ? responses(endpoint, params)
            : responses[endpoint])) ?? (endpoint === 'getTrainCoach' ? { results: [] } : []),
      };
    },
  };
  const context = vm.createContext({
    RailWatchRuntime: runtime,
    document: {
      getElementById: () => null,
      querySelector: (selector) =>
        selector === '#uid'
          ? signedIn === null
            ? null
            : account
          : selector.startsWith('#userName[')
            ? signedIn === false
              ? login
              : null
            : {},
      addEventListener(type, fn) {
        (documentListeners[type] ||= []).push(fn);
      },
      dispatchEvent(event) {
        documentEvents.push(event);
      },
      documentElement: {},
      body: { append() {} },
      head: { append() {} },
      createElement() {
        const element = new Element();
        element.attachShadow = () => root;
        return element;
      },
    },
    window: { addEventListener() {} },
    location: { search: '', pathname },
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    innerWidth: 1200,
    innerHeight: 800,
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [currentTime]));
      }
      static now() {
        return currentTime;
      }
    },
    Intl,
    URLSearchParams,
    console,
    navigator: { locks: { request: async (_name, fn) => fn() } },
    setTimeout(fn, delay) {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestAnimationFrame: (fn) => fn(),
    MutationObserver: class {
      constructor(fn) {
        authObservers.push(fn);
      }
      observe() {}
    },
  });
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
  scripts ||= manifest.content_scripts
    .filter((entry) => (entry.world || 'ISOLATED') === 'ISOLATED')
    .flatMap((entry) => entry.js);
  for (const script of scripts)
    vm.runInContext(fs.readFileSync('extension/' + script, 'utf8'), context, { filename: script });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    storage: runtime.storage.local,
    documentEvents,
    async documentEvent(type, detail) {
      for (const fn of documentListeners[type] || []) await fn({ detail: JSON.stringify(detail) });
    },
    elements,
    filters,
    palettes,
    cadences,
    dateLabels,
    memory,
    messages,
    requests,
    root,
    timers,
    setTime: (value) => (currentTime = Date.parse(value)),
    setSignedIn(value) {
      signedIn = value;
      account.value = value ? 'signed-in' : '';
      authObservers.forEach((fn) => fn());
    },
    loginClicks: () => loginClicks,
  };
}

module.exports = { dashboard };
