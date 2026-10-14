(() => {
  if (document.getElementById('rail-watch-extension')) return;
  const mount = document.createElement('div');
  mount.id = 'rail-watch-extension';
  document.body.append(mount);
  const root = mount.attachShadow({ mode: 'open' });
  root.innerHTML = RailWatchUI.markup;
  const runtime = globalThis.RailWatchRuntime || chrome;
  const preview = runtime.mode === 'preview';

  const pending = new Map();
  const $ = (id) =>
    root.getElementById(id) ?? passengerEditor?.querySelector(`[id="${id}"]`) ?? null;
  let passengerEditor = null;
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char],
    );
  const saveState = async (state) => {
    try {
      await runtime.storage.local.set({ railWatch: state });
    } catch {}
  };

  let stations = [];
  let stationState = { status: 'idle', error: '' };
  let route = { origin: null, destination: null };
  let data = [];
  let dataFilter = 'all';
  let routeResults = {};
  let sidebarCollapsed = false;
  let lastCheck = null;
  let busy = false;
  let activeScan = null;
  let pendingDateCheck = false;
  let paused = false;
  let timer = null;
  let dateFetchTimer = null;
  let nextCheck = null;
  let selected = null;
  let cooldownUntil = 0;
  let bookingWatch = null;
  let watchOutcomeId = null;
  let observedOpenedWatchId = null;
  let dismissedWatchId = null;
  let tooltip;
  let watchDates = null;
  let watchDateScope = null;
  let returnRows = [];
  let returnScope = null;
  const choiceMarkup = { outbound: null, return: null };
  const choiceScope = { outbound: null, return: null };
  const choiceFocus = { outbound: null, return: null };
  let bookingChoices = {
    outbound: { scope: null, alternatives: [] },
    return: { scope: null, alternatives: [] },
  };
  const shell = $('shell');
  const launcher = $('launcher');
  let today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  $('from').value = '';
  $('through').value = '';

  function updateSignInWarning() {
    const account = document.querySelector('#uid');
    const login = document.querySelector(
      '#userName[data-target="#loginModal"],#userName_m[data-target="#loginModal"]',
    );
    const hidden = preview || (account ? Boolean(account.value) : !login);
    const changed = $('signInWarning').hidden !== hidden;
    $('signInWarning').hidden = hidden;
    $('signInButton').disabled = !login;
    if (changed) requestAnimationFrame(fitMatrix);
  }
  $('signInButton').onclick = () => {
    const login = document.querySelector(
      '#userName[data-target="#loginModal"],#userName_m[data-target="#loginModal"]',
    );
    if (login) {
      $('close').click();
      login.click();
    }
  };

  function filterValue() {
    const values = [...$('filter').querySelectorAll('input:checked')].map((input) => input.value);
    return ['1', '2', '3'].every((value) => values.includes(value)) ? 'all' : values.join(',');
  }
  function restoreFilter(value) {
    const values = value === 'all' ? ['1', '2', '3', 'sleep'] : String(value).split(',');
    for (const input of $('filter').querySelectorAll('input'))
      input.checked = values.includes(input.value);
  }
  function match(coach) {
    return RailWatchScanner.matches(coach, filterValue());
  }
  function updateDateBounds() {
    today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const from = $('from');
    const through = $('through');
    const minimum = preview ? runtime.minimumDate : today;
    let changed = false;
    from.min = minimum;
    for (const input of [from, through])
      if (input.value && input.value < minimum) {
        input.value = minimum;
        changed = true;
      }
    through.min = from.value || minimum;
    if (changed) {
      data = [];
      lastCheck = null;
      selected = null;
    }
    return changed;
  }
  const parseDay = (value) => new Date(value + 'T00:00:00Z');
  const isoDay = (time) => new Date(time).toISOString().slice(0, 10);
  function syncDateText() {
    for (const input of [$('from'), $('through')]) {
      const target = root.querySelector(`[data-dtxt="${input.id === 'from' ? 'start' : 'end'}"]`);
      if (!target) continue;
      if (!input.value || !Number.isFinite(+parseDay(input.value))) {
        target.textContent = input.id === 'from' ? 'Start date' : 'End date';
        continue;
      }
      target.textContent = new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      })
        .format(parseDay(input.value))
        .replace(',', '');
    }
  }
  function paintHint(message = '') {
    const hint = $('rangeHint');
    const range = $('dateRange');
    syncDateText();
    if (message) {
      hint.textContent = message;
      return;
    }
    const start = parseDay($('from').value);
    const end = parseDay($('through').value);
    range?.classList.remove('invalid');
    if (!Number.isFinite(+start) || !Number.isFinite(+end)) {
      hint.textContent = $('from').value || $('through').value ? 'Pick both dates' : '';
    } else if (end < start) {
      hint.textContent = 'End date is before start';
      range?.classList.add('invalid');
    } else {
      const count = Math.round((end - start) / 86400000) + 1;
      hint.textContent = count + (count === 1 ? ' day' : ' days');
    }
  }
  function enforceRange(moved) {
    const from = $('from');
    const through = $('through');
    let start = parseDay(from.value);
    let end = parseDay(through.value);
    if (Number.isFinite(+start) && !through.value) {
      through.value = from.value;
      end = start;
    }
    if (Number.isFinite(+end) && !from.value) {
      from.value = through.value;
      start = end;
    }
    if (!Number.isFinite(+start) || !Number.isFinite(+end)) return '';
    let message = '';
    const minimum = from.min;
    if (from.value < minimum) {
      from.value = minimum;
      start = parseDay(minimum);
      message = 'No past dates';
    }
    if (through.value < minimum) {
      through.value = minimum;
      end = parseDay(minimum);
      message = 'No past dates';
    }
    if (moved === 'start') {
      if (end < start) {
        through.value = from.value;
        end = start;
        message = 'End moved to start';
      }
      if ((end - start) / 86400000 > 30) {
        through.value = isoDay(+start + 30 * 86400000);
        message = 'Max range is 31 days';
      }
    } else {
      if (end < start) {
        from.value = through.value;
        start = end;
        message = 'Start moved to end';
      }
      if ((end - start) / 86400000 > 30) {
        from.value = isoDay(+end - 30 * 86400000);
        message = 'Max range is 31 days';
      }
    }
    return message;
  }
  function dates() {
    updateDateBounds();
    if (!route.origin || !route.destination || route.origin.id === route.destination.id) {
      throw Error('Choose two different stations from the suggestions.');
    }
    const start = parseDay($('from').value);
    const end = parseDay($('through').value);
    if (
      !Number.isFinite(+start) ||
      !Number.isFinite(+end) ||
      end < start ||
      (end - start) / 86400000 > 30
    ) {
      throw Error('Choose a date range of up to 31 days.');
    }
    const result = [];
    for (let day = start; day <= end; day = new Date(+day + 86400000))
      result.push(day.toISOString().slice(0, 10));
    return result;
  }
  const key = (iso) => {
    const [year, month, day] = iso.split('-');
    return `${Number(day)}/${month}/${year}`;
  };
  const {
    render: renderUI,
    showDetail,
    fitMatrix,
    updateAvailabilityNotice,
  } = RailWatchUI.create({
    root,
    $,
    escape,
    dates,
    key,
    match,
    state: {
      loadingStatus,
      availabilityStatus,
      get data() {
        return data;
      },
      get cachedData() {
        return (
          routeResults[JSON.stringify([route.origin?.id, route.destination?.id, dataFilter])]
            ?.data || []
        );
      },
      get selected() {
        return selected;
      },
      set selected(value) {
        selected = value;
      },
      get lastCheck() {
        return lastCheck;
      },
    },
  });
  function loadingStatus(date) {
    if (activeScan && (!date || activeScan.settings.dates.includes(date)))
      return !date || activeScan.date === date ? 'checking' : 'waiting';
    if (!paused && !shell.hidden && (dateFetchTimer !== null || pendingDateCheck)) return 'waiting';
    return null;
  }
  function clearDateCheck() {
    clearTimeout(dateFetchTimer);
    dateFetchTimer = null;
    pendingDateCheck = false;
  }
  function availabilityStatus(unchecked) {
    if (busy || loadingStatus())
      return unchecked ? 'Checking the remaining dates…' : 'Checking again…';
    if (paused) return 'Automatic checks are paused. Resume scanning to check again.';
    if (nextCheck) {
      const time = new Date(nextCheck).toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Bangkok',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `Next ${preview ? 'demo ' : ''}check at ${time}.`;
    }
    return 'Click Check now to check again.';
  }
  function render() {
    renderUI();
    renderWatch();
  }
  updateSignInWarning();
  if (!preview && typeof MutationObserver === 'function') {
    new MutationObserver(updateSignInWarning).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['value', 'data-target'],
    });
  }

  let transitionTimer;
  function transitionTheme() {
    shell.classList.add('theme-transition');
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => shell.classList.remove('theme-transition'), 350);
  }
  function applyTheme(theme) {
    shell.setAttribute('data-theme', theme);
  }
  function applyAccent(accent) {
    if (!['brass', 'cyan', 'forest', 'plum'].includes(accent)) accent = 'brass';
    shell.setAttribute('data-accent', accent);
    root.querySelectorAll('.palette-btn').forEach((button) => {
      button.dataset.on = String(button.dataset.val === accent);
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(button.dataset.val === accent));
    });
    const names = {
      brass: 'Platinum & Brass',
      cyan: 'Cyan & Magenta',
      forest: 'Forest & Sunburst',
      plum: 'Plum & Apricot',
    };
    $('palette-label').textContent = names[accent] || names.brass;
  }
  $('themeToggle').onclick = () => {
    transitionTheme();
    applyTheme(shell.dataset.theme === 'dark' ? 'light' : 'dark');
    persist();
  };
  function applySidebar(collapsed) {
    sidebarCollapsed = collapsed;
    $('cockpit').classList.toggle('sidebar-collapsed', collapsed);
    $('sidebar').inert = collapsed;
    $('sidebar').setAttribute('aria-hidden', String(collapsed));
    $('sidebarToggle').setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    $('sidebarToggle').setAttribute('aria-label', label);
    $('sidebarToggle').title = label;
    $('sidebarToggle').dataset.tip = label;
    requestAnimationFrame(fitMatrix);
  }
  $('sidebarToggle').onclick = () => {
    applySidebar(!sidebarCollapsed);
    persist();
  };
  function status(message = '') {
    $('demoChip').hidden = !preview;
    shell.classList.toggle('is-checking', busy && !activeScan);
    shell.classList.toggle('is-scanning', Boolean(activeScan));
    $('statusText').textContent =
      message ||
      (preview
        ? 'Fictional trains, fares and seat counts'
        : busy && activeScan
          ? activeScan.date
            ? 'Checking ' + activeScan.date + '…'
            : 'Waiting for the shared railway checker…'
          : lastCheck
            ? 'Last check ' +
              new Date(lastCheck).toLocaleTimeString('en-GB', {
                timeZone: 'Asia/Bangkok',
                hour: '2-digit',
                minute: '2-digit',
              })
            : route.origin && route.destination
              ? 'Ready to check seats'
              : 'Choose origin and destination stations');
    $('statusText').title =
      message ||
      (preview
        ? 'The preview uses fictional sample data. Install the extension for live availability.'
        : lastCheck
          ? 'Last check ' +
            new Date(lastCheck).toLocaleString('en-GB', {
              timeZone: 'Asia/Bangkok',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }) +
            ' Bangkok'
          : $('statusText').textContent);
    const next = $('nextCheckText');
    let nextDescription;
    if (preview) {
      next.textContent = 'Demo only';
      nextDescription =
        'Checks use fictional sample data. Install the extension on D-Ticket for live seat checks and booking.';
    } else if (busy) {
      next.textContent = 'Checking…';
      nextDescription =
        'A check is running. The next automatic check will be scheduled when it finishes.';
    } else if (paused) {
      next.textContent = 'Paused';
      nextDescription = 'Automatic checks are paused. Click Resume scanning to continue.';
    } else if (nextCheck) {
      next.textContent =
        'Next ' + new Date(nextCheck).toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok' });
      nextDescription =
        'Next automatic check ' +
        new Date(nextCheck).toLocaleString('en-GB', {
          timeZone: 'Asia/Bangkok',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }) +
        ' Bangkok.';
      if (cooldownUntil > Date.now())
        nextDescription += ' Waiting for the D-Ticket rate-limit cooldown.';
    } else {
      next.textContent = 'Not scheduled';
      nextDescription = shell.hidden
        ? 'Open the dashboard to resume automatic checks.'
        : !route.origin || !route.destination || route.origin.id === route.destination.id
          ? 'Choose two different stations to schedule automatic checks.'
          : 'No automatic check is scheduled. Click Check now to start checking seats.';
    }
    next.title = nextDescription;
    next.dataset.tip = nextDescription;
    $('pause').setAttribute('aria-label', paused ? 'Resume scanning' : 'Pause scanning');
    $('pause').title = paused ? 'Resume scanning' : 'Pause scanning';
    $('pause').dataset.tip = $('pause').title;
    $('pause').innerHTML = paused
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 3l15 9-15 9z"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    updateAvailabilityNotice();
  }
  function schedule(checkedAt = null) {
    clearTimeout(timer);
    nextCheck = null;
    if (
      !paused &&
      !busy &&
      !shell.hidden &&
      route.origin &&
      route.destination &&
      route.origin.id !== route.destination.id
    ) {
      const interval = Number($('interval').value);
      const delay = Math.max(
        0,
        interval - (checkedAt && !preview ? Date.now() - checkedAt : 0),
        cooldownUntil - Date.now(),
      );
      nextCheck = Date.now() + delay;
      timer = setTimeout(scan, delay);
    }
    status();
    renderWatch();
  }
  function config() {
    const selectedDates = dates();
    return {
      origin: route.origin.id,
      destination: route.destination.id,
      dates: selectedDates.map(key),
      filter: filterValue(),
      interval: Number($('interval').value),
    };
  }
  const scanner = RailWatchScanner.create({
    storage: runtime.storage.local,
    locks: navigator.locks,
    request,
  });

  const passengerFields = {
    firstName: 'passengerFirstName',
    lastName: 'passengerLastName',
    gender: 'passengerGender',
    foreignerFlag: 'passengerIdType',
    idCard: 'passengerId',
    mobileNo: 'passengerPhone',
    email: 'passengerEmail',
  };
  let passengers = [{ mode: 'account' }];
  let passengerIndex = 0;
  let passengerAccordionOpen = true;
  function passengerProfile() {
    const mode = $('passengerMode').value || 'account';
    if (mode !== 'custom') return { mode };
    const profile = Object.fromEntries(
      Object.entries(passengerFields).map(([field, id]) => [field, $(id).value.trim()]),
    );
    profile.idCard = profile.idCard.replace(/[\s-]/g, '');
    profile.mobileNo = profile.mobileNo.replace(/[\s-]/g, '');
    return { mode, ...profile };
  }
  function showPassengerFields() {
    $('passengerFields').hidden = $('passengerMode').value !== 'custom';
    $('passengerHint').textContent =
      $('passengerMode').value === 'manual' ||
      passengers.some((profile, index) => index !== passengerIndex && profile.mode === 'manual')
        ? 'Manual entry is selected. Automatic Next and autofill are off for this booking.'
        : 'Review passenger details on D-Ticket.';
  }
  function passengerProfiles() {
    passengers[passengerIndex] = passengerProfile();
    return passengers.map((profile) => ({ ...profile }));
  }
  function passengerSummary(profile) {
    return profile.mode === 'account'
      ? 'Account holder'
      : profile.mode === 'manual'
        ? 'Manual entry'
        : [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'Enter details';
  }
  function renderPassengerPicker(animateOpen = false) {
    $('passengerSelect').innerHTML = passengers
      .map(
        (profile, index) =>
          `<option value="${index}">Passenger ${index + 1} · ${escape(passengerSummary(profile))}</option>`,
      )
      .join('');
    $('passengerSelect').value = String(passengerIndex);
    $('passengerSelect').disabled = busy;
    $('addPassenger').disabled = busy || watchActive() || passengers.length >= 4;
    $('removePassenger').disabled = busy || watchActive() || passengers.length <= 1;
    $('passengerCount').textContent =
      `${passengers.length} passenger${passengers.length === 1 ? '' : 's'}`;
    const accordion = $('passengerAccordion');
    passengerEditor ||= $('passengerEditor');
    if (passengerEditor.parentNode) passengerEditor.remove();
    accordion.innerHTML = passengers
      .map((profile, index) => {
        const active = index === passengerIndex;
        const expanded = active && passengerAccordionOpen;
        // When animateOpen, render the active section closed and flip it open on the
        // next frame, so the grid-rows and flex transitions actually have a start state.
        const shownOpen = expanded && !animateOpen;
        return `
      <div class="acc-item${shownOpen ? ' open' : ''}"${active && animateOpen ? ' data-pending-open' : ''}>
        <button type="button" class="acc-head" data-passenger-head="${index}" aria-expanded="${expanded}"${busy ? ' disabled' : ''}>
          <span class="acc-chev" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>
          <span>Passenger ${index + 1}</span>
          <span class="acc-sum">${escape(passengerSummary(profile))}</span>
        </button>
        <div class="acc-panel"><div class="acc-clip"><div class="acc-inner"></div></div></div>
      </div>`;
      })
      .join('');
    passengerEditor.hidden = false;
    accordion
      .querySelector('.acc-item.open .acc-inner, .acc-item[data-pending-open] .acc-inner')
      ?.append(passengerEditor);
    if (animateOpen) {
      requestAnimationFrame(() => {
        const item = accordion.querySelector('.acc-item[data-pending-open]');
        if (!item) return;
        item.getBoundingClientRect(); // commit the closed state so the transition has a start value
        item.classList.add('open');
        item.removeAttribute('data-pending-open');
      });
    }
  }
  function loadPassenger(animateOpen = false) {
    const passenger = passengers[passengerIndex];
    $('passengerMode').value = passenger.mode;
    for (const [field, id] of Object.entries(passengerFields))
      $(id).value =
        passenger[field] || (field === 'gender' ? 'M' : field === 'foreignerFlag' ? 'N' : '');
    const account = $('passengerMode').querySelector('option[value="account"]');
    if (account) account.disabled = passengerIndex !== 0;
    showPassengerFields();
    renderPassengerPicker(animateOpen);
  }
  async function savePassengers(animateOpen = false) {
    try {
      await runtime.storage.local.set({ railWatchPassengers: passengerProfiles() });
    } catch (error) {
      status('Could not save the passenger: ' + error.message);
    }
    showPassengerFields();
    renderPassengerPicker(animateOpen);
    renderWatch();
  }
  for (const id of ['passengerMode', ...Object.values(passengerFields)])
    $(id).addEventListener('change', savePassengers);
  $('passengerSelect').addEventListener('change', () => {
    passengerProfiles();
    const index = Number($('passengerSelect').value);
    if (!Number.isInteger(index) || index < 0 || index >= passengers.length) return;
    passengerIndex = index;
    loadPassenger();
  });
  $('passengerAccordion').addEventListener('click', (event) => {
    const head = event.target.closest('[data-passenger-head]');
    if (!head || head.disabled) return;
    const index = Number(head.dataset.passengerHead);
    if (!Number.isInteger(index) || index < 0 || index >= passengers.length) return;
    if (index === passengerIndex) {
      passengerAccordionOpen = !passengerAccordionOpen;
      const item = head.closest('.acc-item');
      item.classList.toggle('open', passengerAccordionOpen);
      head.setAttribute('aria-expanded', String(passengerAccordionOpen));
      if (passengerAccordionOpen) item.querySelector('.acc-inner')?.append(passengerEditor);
      else if (passengerEditor.parentNode) passengerEditor.remove();
      return;
    }
    passengerProfiles();
    passengerIndex = index;
    passengerAccordionOpen = true;
    loadPassenger(true);
  });
  $('addPassenger').onclick = async () => {
    if (busy || watchActive() || passengers.length >= 4) return;
    passengerProfiles();
    passengers.push({ mode: 'custom', gender: 'M', foreignerFlag: 'N' });
    passengerIndex = passengers.length - 1;
    passengerAccordionOpen = true;
    loadPassenger(true);
    await savePassengers(true);
    $('passengerFirstName').focus();
  };
  $('removePassenger').onclick = async () => {
    if (busy || watchActive() || passengers.length <= 1) return;
    passengerProfiles();
    passengers.splice(passengerIndex, 1);
    passengerIndex = Math.min(passengerIndex, passengers.length - 1);
    loadPassenger();
    await savePassengers();
  };
  document.addEventListener('rail-watch-passenger-request', async (event) => {
    if (preview || location.pathname !== '/DTicketPublicWeb/booking/booking') return;
    try {
      const { id, bookingId } = JSON.parse(event.detail);
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        typeof bookingId !== 'string' ||
        !/^[\w-]{1,100}$/.test(bookingId)
      )
        return;
      const { passengers: profiles } = await runtime.runtime.sendMessage({
        type: 'rail-watch-passenger',
        bookingId,
      });
      if (RailWatchBooking.validatePassengers(profiles)) return;
      document.dispatchEvent(
        new CustomEvent('rail-watch-passenger-response', {
          detail: JSON.stringify({ id, passengers: profiles }),
        }),
      );
    } catch {}
  });

  function watchActive() {
    return ['armed', 'opening'].includes(bookingWatch?.status);
  }
  function bookingError(message = '') {
    $('bookingSetupError').textContent = message;
    $('bookingSetupError').hidden = !message;
  }
  $('bookingSetup').onclick = () => {
    watchOutcomeId = null;
    bookingError();
    passengerAccordionOpen = true;
    renderWatch();
    $('bookingSetupDialog').showModal();
  };
  $('watchBannerView').onclick = () => $('bookingSetup').click();
  $('watchOutcomeEdit').onclick = () => {
    watchOutcomeId = null;
    renderWatch();
    $('bookingTripType').focus();
  };
  $('watchOutcomeDone').onclick = () => {
    $('bookingSetupDialog').close();
    $('watchBanner').focus();
  };
  $('watchBannerPause').onclick = () => $('pause').click();
  $('watchBannerCancel').onclick = () => $('cancelWatch').click();
  $('watchBannerClose').onclick = () => {
    if (bookingWatch?.status !== 'opened') return;
    dismissedWatchId = bookingWatch.id;
    renderWatch();
    persist();
    $('pause').focus({ preventScroll: true });
  };
  $('bookingTripType').value = '1';
  $('preferLowerBerths').checked = true;
  for (const id of ['bookingSetupClose', 'bookingSetupDone'])
    $(id).onclick = () => $('bookingSetupDialog').close();
  function renderChoices(leg, rows, date, known = true) {
    const active = watchActive();
    const scope = JSON.stringify([
      leg === 'return' ? route.destination?.id : route.origin?.id,
      leg === 'return' ? route.origin?.id : route.destination?.id,
      date,
    ]);
    const watched = leg === 'return' ? bookingWatch?.returnLeg : bookingWatch;
    let selection = bookingChoices[leg];
    if (selection.scope !== scope) selection = bookingChoices[leg] = { scope, alternatives: [] };
    const chosen = active ? watched?.alternatives || [] : selection.alternatives;
    const selected = new Set(chosen.map((c) => c.train + '|' + c.coachId));
    const sorted = [...rows].sort(
      (a, b) =>
        a.departure.localeCompare(b.departure) ||
        a.train.localeCompare(b.train, undefined, { numeric: true }),
    );
    const choices = active
      ? chosen
      : [
          ...new Map(
            sorted
              .flatMap((row) =>
                row.coaches.filter(match).map((coach) => ({
                  train: row.train,
                  coachId: coach.id,
                  coachLabel:
                    coach.desc || 'Class ' + coach.class + ' · ' + coach.type + ' · ' + coach.air,
                })),
              )
              .map((choice) => [choice.train + '|' + choice.coachId, choice]),
          ).values(),
        ];
    if (!active && known)
      selection.alternatives = choices.filter((c) => selected.has(c.train + '|' + c.coachId));
    const groups = [...new Set(choices.map((c) => c.train))];
    const title = leg === 'return' ? 'Return' : 'Outbound';
    const container = $(leg === 'return' ? 'returnChoices' : 'watchChoices');
    const openTrains = new Map(
      choiceScope[leg] === scope
        ? [...container.querySelectorAll('details[data-watch-train]')].map((el) => [
            el.dataset.watchTrain,
            el.open,
          ])
        : [],
    );
    const focused = root.activeElement;
    if (focused?.dataset.watchLeg === leg)
      choiceFocus[leg] = { train: focused.dataset.train, coachId: focused.dataset.coachId, scope };
    else if (focused || choiceFocus[leg]?.scope !== scope) choiceFocus[leg] = null;
    const focusedTrain =
      focused?.dataset.watchSummaryLeg === leg ? focused.dataset.watchSummary : null;
    const markup =
      groups
        .map((train, index) => {
          const row = sorted.find((r) => r.train === train);
          const trainChoices = choices.filter((c) => c.train === train);
          const selectedCount = trainChoices.filter((c) =>
            selected.has(train + '|' + c.coachId),
          ).length;
          const expanded = openTrains.has(train)
            ? openTrains.get(train)
            : selectedCount > 0 || index === 0;
          const items = trainChoices
            .map((choice) => {
              const coach = sorted
                .find((r) => r.train === train && r.coaches.some((c) => c.id === choice.coachId))
                ?.coaches.find((c) => c.id === choice.coachId);
              const counts = rows
                .filter((r) => r.train === train)
                .flatMap((r) =>
                  r.coaches.filter((c) => c.id === choice.coachId).map((c) => c.count),
                );
              const maxSeats = Math.max(0, ...counts);
              const multi =
                leg === 'outbound' &&
                $('bookingTripType').value === '1' &&
                (active ? bookingWatch.dates?.length : watchDates?.length) > 1;
              const seats =
                multi && counts.length
                  ? maxSeats > 0
                    ? 'Up to ' + maxSeats + (maxSeats === 1 ? ' seat' : ' seats')
                    : 'Sold out'
                  : coach
                    ? coach.count === 0
                      ? 'Sold out'
                      : coach.count + (coach.count === 1 ? ' seat' : ' seats')
                    : 'Not checked';
              const label = coach
                ? 'Class ' +
                  coach.class +
                  ' · ' +
                  (coach.type === 'Sleeping Coach' ? 'Sleeper' : 'Seat') +
                  ' · ' +
                  (coach.air === 'Air Coach' ? 'A/C' : 'Fan')
                : choice.coachLabel;
              const checked = selected.has(train + '|' + choice.coachId);
              return `<label class="watch-choice${checked ? ' is-selected' : ''}"><input type="checkbox" data-watch-leg="${leg}" data-train="${escape(train)}" data-coach-id="${escape(choice.coachId)}" data-sleeper="${coach?.type === 'Sleeping Coach'}" aria-label="${escape(title + ' train ' + train + ', ' + choice.coachLabel)}"${checked ? ' checked' : ''}${busy || active ? ' disabled' : ''}><span class="watch-choice-copy"><span>${escape(label)}</span>${label !== choice.coachLabel ? `<span class="watch-choice-description">${escape(choice.coachLabel)}</span>` : ''}</span><span class="watch-choice-count">${escape(seats)}</span></label>`;
            })
            .join('');
          return `<details class="watch-train" data-watch-train="${escape(train)}"${expanded ? ' open' : ''}><summary data-watch-summary="${escape(train)}" data-watch-summary-leg="${leg}"><span class="watch-train-copy"><strong>Train ${escape(train)}</strong>${row ? `<span>${escape(row.departure)} → ${escape(row.arrival)}</span>` : ''}</span><span class="watch-train-count${selectedCount ? ' is-selected' : ''}">${selectedCount ? selectedCount + ' selected' : trainChoices.length + ' coaches'}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="watch-train-coaches">${items}</div></details>`;
        })
        .join('') ||
      `<p class="note">${leg === 'return' ? 'Load return trains to choose coaches.' : 'Run Check now to choose train and coach options.'}</p>`;
    const signature = markup.replace(/ open(?=>)/g, '');
    if (choiceScope[leg] !== scope || choiceMarkup[leg] !== signature) {
      container.innerHTML = markup;
      choiceMarkup[leg] = signature;
      choiceScope[leg] = scope;
      if (focusedTrain) container.querySelector(`[data-watch-summary="${focusedTrain}"]`)?.focus();
    }
    if (!busy && !active && choiceFocus[leg]) {
      const { train, coachId } = choiceFocus[leg];
      container.querySelector(`[data-train="${train}"][data-coach-id="${coachId}"]`)?.focus();
      choiceFocus[leg] = null;
    }
    const count = known || active ? (active ? chosen : selection.alternatives).length : 0;
    $(leg === 'return' ? 'returnChoiceCount' : 'watchChoiceCount').textContent =
      `${count} ${count === 1 ? 'coach' : 'coaches'} selected`;
    $(leg + 'Sleepers').disabled =
      busy || active || !container.querySelector('input[data-sleeper="true"]');
    $(leg + 'ClearChoices').disabled = busy || active || !count;
    $(leg + 'AllChoices').disabled = busy || active || !choices.length;
    $(leg + 'QuickSelect').disabled = busy || active || !choices.length;
    if ($(leg + 'QuickSelect').disabled && $(leg + 'QuickMenu').matches(':popover-open'))
      $(leg + 'QuickMenu').hidePopover();
  }

  for (const leg of ['outbound', 'return']) {
    const trigger = $(leg + 'QuickSelect');
    const menu = $(leg + 'QuickMenu');
    menu.addEventListener('beforetoggle', (event) => {
      trigger.setAttribute('aria-expanded', event.newState === 'open');
    });
    function positionMenu() {
      const rect = trigger.getBoundingClientRect();
      menu.style.left =
        Math.max(12, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 12)) +
        'px';
      const top = rect.bottom + 6;
      menu.style.top =
        Math.max(
          12,
          Math.min(
            top + menu.offsetHeight > innerHeight - 12 ? rect.top - menu.offsetHeight - 6 : top,
            innerHeight - menu.offsetHeight - 12,
          ),
        ) + 'px';
    }
    $('bookingSetupFields').addEventListener('scroll', () => {
      if (!menu.matches(':popover-open')) return;
      const rect = trigger.getBoundingClientRect();
      const body = $('bookingSetupFields').getBoundingClientRect();
      if (rect.bottom < body.top || rect.top > body.bottom) menu.hidePopover();
      else positionMenu();
    });
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      if (trigger.disabled) return;
      if (menu.matches(':popover-open')) menu.hidePopover();
      else {
        closeQuickMenus();
        menu.showPopover();
        positionMenu();
        menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
      }
    });
    menu.addEventListener('pointerdown', (event) => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      event.preventDefault();
      button.focus({ preventScroll: true });
    });
    function closeOnEscape(event) {
      if (event.key === 'Escape' && menu.matches(':popover-open')) {
        event.preventDefault();
        menu.hidePopover();
        trigger.focus();
      }
    }
    trigger.addEventListener('keydown', closeOnEscape);
    menu.addEventListener('keydown', closeOnEscape);
    menu.addEventListener('keydown', (event) => {
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(root.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
      if (event.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        buttons[next]?.focus({ preventScroll: true });
      }
    });
    menu.addEventListener('focusout', (event) => {
      if (
        menu.matches(':popover-open') &&
        event.relatedTarget !== trigger &&
        !menu.contains(event.relatedTarget)
      )
        menu.hidePopover();
    });
    for (const action of ['Sleepers', 'AllChoices', 'ClearChoices'])
      $(leg + action).onclick = () => {
        if (busy || watchActive()) return;
        const container = $(leg === 'return' ? 'returnChoices' : 'watchChoices');
        const choices = bookingChoices[leg].alternatives;
        if (action === 'ClearChoices') bookingChoices[leg].alternatives = [];
        else
          for (const input of container.querySelectorAll(
            action === 'Sleepers' ? 'input[data-sleeper="true"]' : 'input[data-watch-leg]',
          )) {
            if (
              !choices.some(
                (c) => c.train === input.dataset.train && c.coachId === input.dataset.coachId,
              )
            )
              choices.push({ train: input.dataset.train, coachId: input.dataset.coachId });
          }
        saveBookingSetup();
        if (menu.matches(':popover-open')) menu.hidePopover();
        trigger.focus();
      };
  }
  function closeQuickMenus() {
    for (const leg of ['outbound', 'return']) {
      const menu = $(leg + 'QuickMenu');
      if (menu.matches(':popover-open')) menu.hidePopover();
    }
  }
  $('bookingSetupDialog').addEventListener('close', closeQuickMenus);
  window.addEventListener('resize', closeQuickMenus);

  function renderWatch() {
    const active = watchActive();
    if (active) $('preferLowerBerths').checked = bookingWatch.preferLowerBerths !== false;
    $('preferLowerBerths').disabled = busy || active;
    let days = [];
    try {
      days = config().dates;
    } catch {}
    const previous = $('watchDate').value;
    const choices = active ? [bookingWatch.date] : days;
    $('watchDate').innerHTML = choices.length
      ? choices.map((date) => `<option value="${escape(date)}">${escape(date)}</option>`).join('')
      : '<option value="">Choose a route and dates</option>';
    $('watchDate').value = choices.includes(previous) ? previous : choices[0] || '';
    $('watchDate').disabled = busy || active || !choices.length;
    if (active) {
      passengers = bookingWatch.passengers.map((profile) => ({ ...profile }));
      passengerIndex = Math.min(passengerIndex, passengers.length - 1);
      loadPassenger();
      $('bookingTripType').value = bookingWatch.returnLeg ? '2' : '1';
    }
    const roundTrip = $('bookingTripType').value === '2';
    const scope = JSON.stringify([route.origin?.id, route.destination?.id]);
    if (watchDateScope !== scope) {
      watchDateScope = scope;
      watchDates = null;
    }
    if (watchDates === null && days.length) watchDates = [$('watchDate').value];
    if (!active)
      watchDates = watchDates === null ? null : days.filter((date) => watchDates.includes(date));
    const departureDates = active ? bookingWatch.dates || [bookingWatch.date] : watchDates || [];
    const shortDate = (date) =>
      new Date(RailWatchBooking.day(date) + 'T00:00:00Z').toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });
    $('watchDatesText').textContent = !departureDates.length
      ? 'Choose dates'
      : departureDates.length <= 3
        ? departureDates.map(shortDate).join(', ')
        : `${departureDates.length} dates · ${shortDate(departureDates[0])}–${shortDate(departureDates.at(-1))}`;
    $('watchDatesCalendar').disabled = busy || active || !days.length;
    calendar.refreshWatch();
    $('watchDateChoices').hidden = roundTrip;
    $('watchDateRow').hidden = !roundTrip;
    if (!roundTrip && departureDates.length) $('watchDate').value = departureDates[0];
    const outboundDates = roundTrip ? [$('watchDate').value] : departureDates;
    $('bookingTripType').disabled = busy || active;
    $('returnLegFields').hidden = !roundTrip;
    const outboundDay = RailWatchBooking.day($('watchDate').value);
    $('returnDate').min = outboundDay || today;
    if (active && bookingWatch.returnLeg)
      $('returnDate').value = RailWatchBooking.day(bookingWatch.returnLeg.date);
    else if (!$('returnDate').value || $('returnDate').value < $('returnDate').min)
      $('returnDate').value = $('returnDate').min;
    const returnKey = JSON.stringify([
      route.destination?.id,
      route.origin?.id,
      $('returnDate').value,
    ]);
    renderChoices(
      'outbound',
      data.filter((row) => outboundDates.includes(row.date)),
      outboundDates.length === 1 ? outboundDates[0] : outboundDates.join(','),
    );
    renderChoices(
      'return',
      returnScope === returnKey ? returnRows : [],
      $('returnDate').value ? key($('returnDate').value) : '',
      returnScope === returnKey,
    );
    $('returnDate').disabled = busy || active;
    $('loadReturn').disabled = busy || active || !roundTrip || !outboundDay;
    $('outboundRoute').textContent =
      'Outbound' +
      (route.origin && route.destination
        ? ' · ' + route.origin.name + ' → ' + route.destination.name
        : '');
    $('returnRoute').textContent =
      'Return' +
      (route.origin && route.destination
        ? ' · ' + route.destination.name + ' → ' + route.origin.name
        : '');
    $('bookingMeta').textContent =
      `${roundTrip ? 'Round trip' : 'One way'} · ${passengers.length} ${passengers.length === 1 ? 'passenger' : 'passengers'}`;
    const outbound = active ? bookingWatch.alternatives : bookingChoices.outbound.alternatives;
    const inbound = active
      ? bookingWatch.returnLeg?.alternatives || []
      : bookingChoices.return.alternatives;
    const ready =
      outboundDates.length > 0 &&
      outbound.length > 0 &&
      (!roundTrip || (returnScope === returnKey && inbound.length > 0));
    $('bookNow').disabled = busy || active || !ready;
    $('bookNow').hidden = active;
    $('armWatch').hidden = active;
    $('armWatch').disabled = busy || !ready;
    $('cancelWatch').hidden = !active;
    $('cancelWatch').disabled = bookingWatch?.status === 'opening';
    renderPassengerPicker();
    $('bookingPassengers').classList.toggle(
      'is-compact',
      passengers.length === 1 && passengers[0].mode !== 'custom',
    );
    $('armWatch').textContent = 'Start watch';
    const seatCount = active ? passengers.length : bookingWatch?.seatCount || passengers.length;
    const waiting = `Waiting for ${seatCount} ${seatCount === 1 ? 'seat' : 'seats'} in one selected coach${roundTrip ? ' on each leg' : ''}.`;
    const summary = bookingWatch
      ? `${bookingWatch.routeLabel || ''} · ${bookingWatch.dates ? (bookingWatch.dates.length > 3 ? bookingWatch.dates.length + ' departure dates · ' + bookingWatch.dates[0] + ' – ' + bookingWatch.dates.at(-1) : bookingWatch.dates.join(', ')) : bookingWatch.date}${bookingWatch.returnLeg ? ' · Return ' + bookingWatch.returnLeg.date : ''}`
      : '';
    const matched = bookingWatch?.selected
      ? `Train ${bookingWatch.selected.train} · ${bookingWatch.selected.date || bookingWatch.date}${bookingWatch.selected.returnLeg ? ' · Return train ' + bookingWatch.selected.returnLeg.train + ' · ' + bookingWatch.selected.returnLeg.date : ''}`
      : '';
    $('watchStatus').textContent =
      bookingWatch?.status === 'armed'
        ? paused
          ? 'Watch paused. Resume from the dashboard.'
          : waiting
        : bookingWatch?.status === 'opening'
          ? 'Seats found. Opening one booking on D-Ticket…'
          : bookingWatch?.status === 'opened'
            ? preview
              ? 'Demo match found. ' + matched + '. No booking opened.'
              : 'Booking opened for ' +
                matched +
                '. Review passenger details on D-Ticket. The watch has stopped.'
            : bookingWatch?.status === 'error'
              ? 'Watch stopped: ' + bookingWatch.error + '. Check your choices and start again.'
              : `Waits for seats for everyone${roundTrip ? ' on both legs' : ''}, then opens one booking.`;
    const show = ['armed', 'opening', 'opened', 'error'].includes(bookingWatch?.status);
    $('watchBanner').hidden =
      !show || (bookingWatch?.status === 'opened' && bookingWatch.id === dismissedWatchId);
    $('watchBanner').dataset.state =
      bookingWatch?.status === 'armed' && paused ? 'paused' : bookingWatch?.status || '';
    $('watchBannerTitle').textContent =
      bookingWatch?.status === 'armed'
        ? paused
          ? 'Watch paused'
          : `Watching for ${seatCount} ${seatCount === 1 ? 'seat' : 'seats'}${bookingWatch.returnLeg ? ' per leg' : ''}`
        : bookingWatch?.status === 'opening'
          ? 'Seats found · opening booking'
          : bookingWatch?.status === 'opened'
            ? preview
              ? 'Demo match found · watch stopped'
              : 'Booking opened · watch stopped'
            : 'Watch stopped';
    $('watchBannerText').textContent =
      bookingWatch?.status === 'armed' ? summary : $('watchStatus').textContent;
    const trainCount = (leg) => new Set(leg.alternatives.map((c) => c.train)).size;
    const describe = (leg) =>
      `${trainCount(leg)} ${trainCount(leg) === 1 ? 'train' : 'trains'} · ${leg.alternatives.length} ${leg.alternatives.length === 1 ? 'coach' : 'coaches'}`;
    $('watchBannerMeta').hidden = bookingWatch?.status !== 'armed';
    $('watchBannerMeta').textContent =
      bookingWatch?.status === 'armed'
        ? `${bookingWatch.returnLeg ? 'Outbound: ' : ''}${describe(bookingWatch)}${bookingWatch.returnLeg ? ' / Return: ' + describe(bookingWatch.returnLeg) : ''} · ${paused ? 'Checks paused' : 'Checks every ' + Number($('interval').value) / 60000 + ' min'}`
        : '';
    $('watchLockHint').hidden = !active;
    $('watchBannerCancel').hidden = bookingWatch?.status !== 'armed';
    $('watchBannerPause').hidden = bookingWatch?.status !== 'armed';
    $('watchBannerClose').hidden = bookingWatch?.status !== 'opened';
    $('watchBannerPause').textContent = paused ? 'Resume' : 'Pause';
    $('watchBannerPause').setAttribute('aria-label', paused ? 'Resume watch' : 'Pause watch');
    $('watchBannerView').textContent = active ? 'View choices' : 'Edit choices';
    for (const id of [
      'origin',
      'destination',
      'swap',
      'from',
      'through',
      'fromCalendar',
      'throughCalendar',
    ])
      $(id).setAttribute('aria-describedby', active ? 'watchLockHint' : '');
    for (const input of $('filter').querySelectorAll('input'))
      input.setAttribute('aria-describedby', active ? 'watchLockHint' : '');
    $('bookingWatchLockHint').hidden = !active;
    for (const id of [
      'bookingTripType',
      'watchDate',
      'watchDatesCalendar',
      'preferLowerBerths',
      'outboundSleepers',
      'outboundClearChoices',
      'outboundAllChoices',
      'outboundQuickSelect',
      'returnSleepers',
      'returnClearChoices',
      'returnAllChoices',
      'returnQuickSelect',
      'returnDate',
      'passengerMode',
      ...Object.values(passengerFields),
    ])
      $(id).setAttribute('aria-describedby', active ? 'bookingWatchLockHint' : '');
    if (active) hideTooltip();
    const completed = bookingWatch?.status === 'opened' && bookingWatch.selected;
    const newlyCompleted = completed && observedOpenedWatchId !== bookingWatch.id;
    if (newlyCompleted) {
      observedOpenedWatchId = bookingWatch.id;
      if ($('bookingSetupDialog').open) watchOutcomeId = bookingWatch.id;
    }
    const outcome = completed && watchOutcomeId === bookingWatch.id;
    $('bookingSetupFields').hidden = Boolean(outcome);
    $('bookingSetupFooter').hidden = Boolean(outcome);
    $('watchOutcome').hidden = !outcome;
    $('bookingSetupDialog').classList.toggle('is-complete', Boolean(outcome));
    $('bookingSetupHeading').textContent = outcome
      ? preview
        ? 'Demo seats found'
        : 'Booking opened'
      : 'Booking setup';
    if (outcome) {
      $('bookingMeta').textContent = bookingWatch.routeLabel || '';
      $('watchOutcomeMessage').textContent = preview
        ? 'The selected coaches have seats for your group. No booking was opened in this demo.'
        : 'Your booking is open on D-Ticket. Review the passenger details there. The watch has stopped.';
      const legMarkup = (label, leg, date) =>
        `<div><dt>${escape(label + ' · ' + date)}</dt><dd><strong>Train ${escape(leg.train)}</strong></dd><dd>${escape(leg.coachLabel)}</dd></div>`;
      $('watchOutcomeTrips').innerHTML =
        legMarkup(
          bookingWatch.returnLeg ? 'Outbound' : 'Departure',
          bookingWatch.selected,
          bookingWatch.selected.date || bookingWatch.date,
        ) +
        (bookingWatch.selected.returnLeg
          ? legMarkup(
              'Return',
              bookingWatch.selected.returnLeg,
              bookingWatch.selected.returnLeg.date,
            )
          : '');
      if (newlyCompleted) {
        bookingError();
        hideTooltip();
        $('watchOutcome').focus();
      }
    }
  }

  async function saveBookingSetup() {
    renderWatch();
    try {
      await runtime.storage.local.set({
        railWatchBookingSetup: {
          tripType: $('bookingTripType').value,
          returnDate: $('returnDate').value,
          choices: bookingChoices,
          departureDates: watchDates,
          dateScope: watchDateScope,
          preferLowerBerths: $('preferLowerBerths').checked,
        },
      });
    } catch (error) {
      bookingError('Could not save booking setup: ' + error.message);
    }
  }
  for (const id of ['watchDate', 'bookingTripType', 'returnDate', 'preferLowerBerths'])
    $(id).addEventListener('change', () => {
      if (id === 'watchDate' && (watchDates?.length || 0) <= 1) watchDates = [$('watchDate').value];
      saveBookingSetup();
    });
  $('loadReturn').onclick = async () => {
    if (busy || watchActive()) return;
    bookingError();
    try {
      const settings = config();
      const date = $('returnDate').value;
      if (!date || date < RailWatchBooking.day($('watchDate').value))
        throw Error('Choose a return date on or after departure.');
      busy = true;
      setRouteDisabled(true);
      clearTimeout(timer);
      const result = await scanner.scan({
        origin: settings.destination,
        destination: settings.origin,
        dates: [key(date)],
        filter: 'all',
        interval: 300000,
      });
      returnRows = result.rows;
      returnScope = JSON.stringify([settings.destination, settings.origin, date]);
      if (!returnRows.length)
        bookingError('No return trains listed for this date. Choose another date.');
    } catch (error) {
      bookingError('Could not load return trains: ' + error.message);
      failed(error);
    } finally {
      busy = false;
      setRouteDisabled(false);
      schedule();
      renderWatch();
    }
  };
  function bookingSelection() {
    const settings = config();
    return {
      origin: settings.origin,
      destination: settings.destination,
      routeLabel: route.origin.name + ' → ' + route.destination.name,
      date: $('bookingTripType').value === '2' ? $('watchDate').value : watchDates?.[0] || '',
      ...($('bookingTripType').value === '1' && watchDates?.length > 1
        ? { dates: [...watchDates] }
        : {}),
      alternatives: bookingChoices.outbound.alternatives.map((choice) => ({ ...choice })),
      passengers: passengerProfiles(),
      preferLowerBerths: $('preferLowerBerths').checked,
      ...($('bookingTripType').value === '2'
        ? {
            returnLeg: {
              date: key($('returnDate').value),
              alternatives: bookingChoices.return.alternatives.map((choice) => ({ ...choice })),
            },
          }
        : {}),
    };
  }
  async function verifyBooking(target) {
    const legs = [
      target,
      ...(target.returnLeg
        ? [{ ...target.returnLeg, origin: target.destination, destination: target.origin }]
        : []),
    ];
    const checks = [];
    for (const leg of legs) {
      const settings = {
        origin: leg.origin,
        destination: leg.destination,
        dates: leg.dates || [leg.date],
        filter: 'all',
      };
      const rows = [];
      for (const date of settings.dates) {
        for (const train of new Set(leg.alternatives.map((choice) => choice.train))) {
          let result;
          try {
            result = await scanner.verify(settings, date, train, {});
          } catch (error) {
            if (error.code !== 'RAIL_WATCH_TRAIN_MISSING') throw error;
            result = { coaches: [], checkedAt: new Date().toISOString() };
          }
          const row = { date, train, coaches: result.coaches, checkedAt: result.checkedAt };
          rows.push(row);
          if (route.origin?.id === leg.origin && route.destination?.id === leg.destination) {
            const current = data.find((item) => item.date === date && item.train === train);
            if (current)
              Object.assign(current, { coaches: result.coaches, checkedAt: result.checkedAt });
          } else if (
            returnScope ===
            JSON.stringify([leg.origin, leg.destination, RailWatchBooking.day(date)])
          ) {
            const current = returnRows.find((item) => item.train === train);
            if (current)
              Object.assign(current, { coaches: result.coaches, checkedAt: result.checkedAt });
          }
        }
        if (
          !target.returnLeg &&
          RailWatchWatch.resolve(target, [{ config: settings, rows, at: Date.now(), fresh: true }])
        )
          break;
      }
      checks.push({
        config: settings,
        rows,
        at: Date.now(),
        fresh: true,
      });
    }
    render();
    await persist();
    return checks;
  }
  async function sendWatchResult(settings, rows, at) {
    if (bookingWatch?.status !== 'armed') return;
    const response = await runtime.runtime.sendMessage({
      type: 'rail-watch-result',
      id: bookingWatch.id,
      checks: [{ config: settings, rows, at, fresh: true }],
    });
    if (response?.error) throw Error(response.error);
    if (response?.watch) bookingWatch = response.watch;
    renderWatch();
  }
  async function checkArmedWatch() {
    if (busy || bookingWatch?.status !== 'armed') return;
    const target = bookingWatch;
    let checkError;
    busy = true;
    setRouteDisabled(true);
    $('refresh').disabled = true;
    clearTimeout(timer);
    try {
      status(
        target.returnLeg
          ? 'Checking choices on both legs…'
          : 'Checking watched train and coach choices…',
      );
      const checks = await verifyBooking(target);
      const response = await runtime.runtime.sendMessage({
        type: 'rail-watch-result',
        id: target.id,
        checks,
      });
      if (response?.error) throw Error(response.error);
      if (response?.watch) bookingWatch = response.watch;
    } catch (error) {
      checkError = error;
    } finally {
      busy = false;
      $('refresh').disabled = false;
      setRouteDisabled(false);
      schedule();
      if (checkError) failed(checkError);
      renderWatch();
    }
  }
  $('armWatch').onclick = async () => {
    if (busy || watchActive()) return;
    bookingError();
    try {
      const watch = bookingSelection();
      const error = RailWatchWatch.validate(watch);
      if (error) {
        bookingError(error);
        return;
      }
      $('armWatch').disabled = true;
      const response = await runtime.runtime.sendMessage({ type: 'rail-watch-arm', watch });
      if (response?.error) throw Error(response.error);
      bookingWatch = response.watch;
      paused = false;
      setRouteDisabled(false);
      renderWatch();
      await checkArmedWatch();
    } catch (error) {
      bookingError('Could not start watch: ' + error.message);
      renderWatch();
    }
  };
  $('bookNow').onclick = async () => {
    if (busy || watchActive()) return;
    bookingError();
    try {
      const target = bookingSelection();
      const error = RailWatchWatch.validate(target, false);
      if (error) throw Error(error);
      busy = true;
      setRouteDisabled(true);
      clearTimeout(timer);
      await runtime.storage.local.set({ railWatchPassengers: target.passengers });
      status(
        target.returnLeg
          ? 'Checking choices on both legs before opening D-Ticket…'
          : 'Checking selected coaches before opening D-Ticket…',
      );
      const checks = await verifyBooking(target);
      const selected = RailWatchWatch.resolve(target, checks);
      if (!selected)
        throw Error(
          'No selected coach has enough fresh seats for everyone' +
            (target.returnLeg ? ' on both legs' : '') +
            '. Start a watch to wait.',
        );
      const response = await runtime.runtime.sendMessage({
        type: 'rail-watch-booking',
        passengers: target.passengers,
        params: {
          provinceStartId: target.origin,
          provinceEndId: target.destination,
          dateStart: selected.date || target.date,
          trainNo: selected.train,
          coachId: selected.coachId,
          ...(selected.returnLeg ? { returnLeg: selected.returnLeg } : {}),
          autoFill: !target.passengers.some((profile) => profile.mode === 'manual'),
          seatCount: target.passengers.length,
          preferLowerBerths: target.preferLowerBerths,
        },
      });
      if (response?.error) throw Error(response.error);
      status(response?.message || 'D-Ticket opened. Review your booking there.');
    } catch (error) {
      bookingError(error.message);
    } finally {
      busy = false;
      setRouteDisabled(false);
      schedule();
      renderWatch();
    }
  };
  $('cancelWatch').onclick = async () => {
    if (!watchActive()) return;
    try {
      const response = await runtime.runtime.sendMessage({
        type: 'rail-watch-cancel',
        id: bookingWatch.id,
      });
      if (response?.error) throw Error(response.error);
      bookingWatch = response.watch;
      setRouteDisabled(busy);
      renderWatch();
    } catch (error) {
      bookingError('Could not cancel watch: ' + error.message);
    }
  };

  function alertSettings() {
    return {
      enabled: $('alertsEnabled').value === 'on',
      trains: $('alertTrains').value.trim(),
      minimum: Math.min(99, Math.max(1, Number($('alertMinimum').value) || 1)),
    };
  }
  async function saveAlerts() {
    const settings = alertSettings();
    $('alertMinimum').value = String(settings.minimum);
    try {
      await runtime.storage.local.set({ railWatchAlertSettings: settings });
    } catch {}
  }
  for (const id of ['alertsEnabled', 'alertTrains', 'alertMinimum'])
    $(id).addEventListener('change', saveAlerts);
  function alertTrainNumbers() {
    const saved =
      $('alertTrains').value === 'none'
        ? []
        : $('alertTrains')
            .value.split(/[\s,]+/)
            .filter(Boolean);
    return [...new Set([...data.map((row) => row.train), ...saved])].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
  }
  function selectedAlertTrains(numbers = alertTrainNumbers()) {
    const value = $('alertTrains').value;
    return new Set(
      value === '' ? numbers : value === 'none' ? [] : value.split(/[\s,]+/).filter(Boolean),
    );
  }
  function renderAlertTrains() {
    const numbers = alertTrainNumbers();
    const selected = selectedAlertTrains(numbers);
    const all = $('alertsPanel').querySelector('[data-chk-all]');
    all.checked =
      $('alertTrains').value === '' ||
      (numbers.length > 0 && numbers.every((number) => selected.has(number)));
    all.indeterminate = selected.size > 0 && !all.checked;
    all.disabled = numbers.length === 0;
    $('alertTrainLabel').textContent = all.checked
      ? 'All trains'
      : selected.size
        ? 'Train ' + numbers.filter((number) => selected.has(number)).join(', ')
        : 'No trains';
    $('alertTrainOptions').innerHTML = numbers
      .map(
        (number) =>
          '<label class="chk"><input type="checkbox" data-alert-train="' +
          escape(number) +
          '" aria-label="Alert on train ' +
          escape(number) +
          '" ' +
          (selected.has(number) ? 'checked' : '') +
          '><span>Train ' +
          escape(number) +
          '</span></label>',
      )
      .join('');
  }
  function restoreAlertSettings(alerts = { enabled: false, trains: '', minimum: 1 }) {
    $('alertsEnabled').value = alerts.enabled ? 'on' : 'off';
    $('alertTrains').value = alerts.trains || '';
    $('alertMinimum').value = alerts.minimum || 1;
    $('alertSwitch').setAttribute('aria-checked', String(Boolean(alerts.enabled)));
    $('alertsPanel').classList.toggle('on', Boolean(alerts.enabled));
    if (!alerts.enabled) $('alertTrainPicker').open = false;
    renderAlertTrains();
  }
  async function checkAlerts(settings, rows) {
    try {
      const response = await runtime.runtime.sendMessage({
        type: 'rail-watch-alerts',
        config: settings,
        rows,
        routeLabel: `${route.origin.name} → ${route.destination.name}`,
      });
      $('alertError').textContent = response?.error || '';
    } catch (error) {
      $('alertError').textContent = 'Notification failed: ' + error.message;
    }
    $('alertError').hidden = !$('alertError').textContent;
  }
  function renderLog(log) {
    const entries = (log?.entries || []).filter((entry) => entry.count > 0 && entry.count <= 5);
    $('clearLog').disabled = !entries.length;
    $('availabilityLog').innerHTML = entries.length
      ? entries
          .map((entry) => {
            const date = entry.date || '';
            const title = entry.route || '';
            const time = new Date(entry.at).toLocaleTimeString('en-GB', {
              timeZone: 'Asia/Bangkok',
              hour: '2-digit',
              minute: '2-digit',
            });
            let travelDay = new Date(date + 'T00:00:00Z');
            if (date.includes('/')) {
              const [day, month, year] = date.split('/').map(Number);
              travelDay = new Date(Date.UTC(year, month - 1, day));
            }
            const day = Number.isFinite(+travelDay)
              ? travelDay.toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  timeZone: 'UTC',
                })
              : date;
            return `<tr title="${escape(title)}"><td class="mono"><time datetime="${escape(new Date(entry.at).toISOString())}">${escape(time)}</time></td><td class="mono">${escape(day)}</td><td class="mono">${escape(entry.train)}</td><td class="ta-r mono st-txt-low">${escape(entry.count)}</td></tr>`;
          })
          .join('')
      : '<tr><td colspan="4" class="hist-empty">No entries yet</td></tr>';
  }
  function applyHistory(collapsed) {
    $('historyTable').hidden = collapsed;
    $('historyToggle').setAttribute('aria-expanded', String(!collapsed));
  }
  applyHistory(false);
  $('historyToggle').onclick = () => {
    applyHistory(!$('historyTable').hidden);
    persist();
  };
  $('clearLog').onclick = async () => {
    $('clearLog').disabled = true;
    try {
      await runtime.storage.local.remove('railWatchAvailabilityLog');
      renderLog();
    } catch (error) {
      $('clearLog').disabled = false;
      status('Could not clear the availability log: ' + error.message);
    }
  };

  function failed(error) {
    clearDateCheck();
    if (error.retryAt) {
      cooldownUntil = error.retryAt;
      schedule();
      status(
        'Server requested a pause. Next check ' +
          new Date(nextCheck || cooldownUntil).toLocaleTimeString('en-GB', {
            timeZone: 'Asia/Bangkok',
          }) +
          ' Bangkok. Previous results retained.',
      );
    } else {
      paused = true;
      clearTimeout(timer);
      status(
        'Check stopped: ' +
          error.message +
          '. Previous results retained. Log in again if your session expired.',
      );
    }
  }
  async function request(endpoint, params) {
    if (runtime.request) return runtime.request(endpoint, params);
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(Error('Request timed out after 45 seconds'));
      }, 45000);
      pending.set(id, { resolve, reject, timeout });
      document.dispatchEvent(
        new CustomEvent('rail-watch-request', { detail: JSON.stringify({ id, endpoint, params }) }),
      );
    });
  }
  document.addEventListener('rail-watch-response', (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timeout);
    message.error
      ? task.reject(
          Object.assign(Error(message.error), {
            httpStatus: message.httpStatus,
            retryAt: message.retryAt,
          }),
        )
      : task.resolve(message.result);
  });
  async function scan(force = false) {
    if (busy) return;
    if (bookingWatch?.status === 'armed') {
      await checkArmedWatch();
      return;
    }
    let settings;
    try {
      settings = config();
    } catch (error) {
      status(error.message);
      return;
    }
    busy = true;
    clearDateCheck();
    activeScan = { settings, date: null };
    setRouteDisabled(true);
    clearTimeout(timer);
    $('refresh').disabled = true;
    status('Waiting for the shared railway checker…');
    render();
    try {
      const result = await scanner.scan(
        settings,
        (day, count) => {
          activeScan.date = day;
          status('Checking ' + day + '… ' + count + ' train results');
          render();
        },
        { force },
      );
      data = result.rows;
      dataFilter = JSON.parse(result.key)[4];
      lastCheck = new Date(result.at).toISOString();
      rememberResults(settings.dates);
      const sameDates = scanner.scopeKey(config()) === scanner.scopeKey(settings);
      if (!sameDates) restoreRouteResults(true);
      renderAlertTrains();
      render();
      await persist();
      if (sameDates && !result.reused)
        await sendWatchResult(settings, result.freshRows || result.rows, result.at);
      if (sameDates && !result.reused) await checkAlerts(settings, result.freshRows || result.rows);
      busy = false;
      schedule(result.reused ? result.at : null);
      if (result.reused)
        $('statusText').title =
          'Using the recent scan shared across tabs. ' + $('statusText').title;
    } catch (error) {
      busy = false;
      failed(error);
    } finally {
      busy = false;
      activeScan = null;
      shell.classList.remove('is-checking');
      $('refresh').disabled = false;
      setRouteDisabled(false);
      if (pendingDateCheck) {
        pendingDateCheck = false;
        queueDateCheck();
      }
      shell.classList.remove('is-scanning');
      render();
    }
  }

  function setRouteDisabled(value) {
    const disabled = value || watchActive();
    for (const id of ['origin', 'destination', 'swap']) $(id).disabled = disabled;
    for (const id of ['from', 'through', 'fromCalendar', 'throughCalendar'])
      $(id).disabled = watchActive() || (value && !activeScan);
    $('filter')
      .querySelectorAll('input')
      .forEach((input) => {
        input.disabled = disabled;
      });
    for (const id of ['passengerMode', ...Object.values(passengerFields)])
      $(id).disabled = disabled;
    renderWatch();
  }
  function persist() {
    rememberResults();
    return saveState({
      schema: 2,
      route,
      data,
      dataFilter,
      routeResults,
      lastCheck,
      from: $('from').value,
      through: $('through').value,
      interval: $('interval').value,
      filter: filterValue(),
      theme: shell.dataset.theme === 'light' ? 'light' : 'dark',
      accent: shell.dataset.accent || 'brass',
      selected,
      sidebarCollapsed,
      historyCollapsed: $('historyTable').hidden,
      dismissedWatchId,
    });
  }
  function rememberResults(replaceDates = []) {
    if (!route.origin || !route.destination || !lastCheck) return;
    const cacheKey = JSON.stringify([route.origin.id, route.destination.id, dataFilter]);
    const previous = (routeResults[cacheKey]?.data || []).filter(
      (row) => !replaceDates.includes(row.date),
    );
    const rows = [
      ...new Map([...previous, ...data].map((row) => [row.date + '|' + row.train, row])).values(),
    ];
    routeResults[cacheKey] = {
      origin: route.origin.id,
      destination: route.destination.id,
      filter: dataFilter,
      data: rows.slice(-400),
      lastCheck,
    };
    routeResults = Object.fromEntries(
      Object.entries(routeResults)
        .sort(([, a], [, b]) => Date.parse(b.lastCheck) - Date.parse(a.lastCheck))
        .slice(0, 12),
    );
  }
  function restoreRouteResults(preserveSelection = false) {
    const requested = filterValue();
    const cached = Object.values(routeResults)
      .filter(
        (result) =>
          result.origin === route.origin?.id &&
          result.destination === route.destination?.id &&
          (result.filter === 'all' ||
            requested.split(',').every((value) => result.filter.split(',').includes(value))),
      )
      .sort((a, b) => Date.parse(b.lastCheck) - Date.parse(a.lastCheck))[0];
    data = cached?.data || [];
    lastCheck = cached?.lastCheck || null;
    dataFilter = cached?.filter || requested;
    if (!preserveSelection) selected = null;
    renderAlertTrains();
    schedule(lastCheck ? Date.parse(lastCheck) : null);
  }
  function changeRoute() {
    rememberResults();
    const find = (name) =>
      stations.find((station) => station.name === name || station.th === name) ||
      [route.origin, route.destination].find((station) => station?.name === name);
    route = {
      origin: find($('origin').value) || null,
      destination: find($('destination').value) || null,
    };
    restoreRouteResults();
    render();
    persist();
  }
  function acPopulate(input, browse = false) {
    const list = input.closest('.ac')?.querySelector('.ac-list');
    if (!list) return;
    input.dataset.browse = String(browse);
    input.setAttribute('aria-controls', input.id + 'Options');
    const pending = stationState.status === 'loading' || stationState.status === 'idle';
    if (pending || stationState.status === 'error') {
      list.innerHTML = pending
        ? '<p class="ac-message">Loading stations…</p>'
        : '<p class="ac-message">Stations could not load. Retry to choose a route.</p><button type="button" class="ac-retry" data-stations-retry>Retry loading stations</button>';
      list.setAttribute('role', 'status');
      input.setAttribute('aria-busy', String(pending));
      input.setAttribute('aria-expanded', 'true');
      list.hidden = false;
      return;
    }
    input.setAttribute('aria-busy', 'false');
    const query = input.value.trim().toLocaleLowerCase();
    const hits =
      query && !browse
        ? stations
            .filter(
              (station) =>
                station.name.toLocaleLowerCase().includes(query) ||
                station.th.toLocaleLowerCase().includes(query),
            )
            .slice(0, 8)
        : stations;
    list.innerHTML = hits
      .map(
        (station) =>
          `<button type="button" class="ac-item" tabindex="-1" data-fill="${escape(station.name)}" role="option" aria-selected="false">${escape(station.name)}</button>`,
      )
      .join('');
    if (!hits.length)
      list.innerHTML = '<p class="ac-message">No matching stations. Try another name.</p>';
    list.setAttribute('role', hits.length ? 'listbox' : 'status');
    list.setAttribute('tabindex', '-1');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    list.hidden = false;
  }
  function setAlertState(enabled) {
    $('alertsEnabled').value = enabled ? 'on' : 'off';
    $('alertSwitch').setAttribute('aria-checked', String(enabled));
    $('alertsPanel').classList.toggle('on', enabled);
    if (!enabled) $('alertTrainPicker').open = false;
    saveAlerts();
  }

  for (const id of ['origin', 'destination']) {
    $(id).addEventListener('input', (event) => acPopulate(event.currentTarget));
    for (const type of ['focus', 'click'])
      $(id).addEventListener(type, (event) => acPopulate(event.currentTarget, true));
    $(id).addEventListener('change', changeRoute);
  }
  let swapAngle = 0;
  $('swap').onclick = () => {
    rememberResults();
    swapAngle += 180;
    $('swap').style.transform = `rotate(${swapAngle}deg)`;
    [route.origin, route.destination] = [route.destination, route.origin];
    $('origin').value = route.origin?.name || '';
    $('destination').value = route.destination?.name || '';
    restoreRouteResults();
    render();
    persist();
  };
  function changeDates(id) {
    updateDateBounds();
    const note = enforceRange(id === 'from' ? 'start' : 'end');
    updateDateBounds();
    paintHint(note);
    rememberResults();
    if (lastCheck) restoreRouteResults(true);
    queueDateCheck();
    render();
    persist();
    schedule();
  }
  function queueDateCheck() {
    clearTimeout(dateFetchTimer);
    dateFetchTimer = null;
    if (
      !paused &&
      !shell.hidden &&
      !watchActive() &&
      route.origin &&
      route.destination &&
      route.origin.id !== route.destination.id
    ) {
      dateFetchTimer = setTimeout(() => {
        dateFetchTimer = null;
        if (paused || shell.hidden || watchActive()) return;
        if (busy) pendingDateCheck = true;
        else scan();
      }, 300);
    }
  }
  for (const id of ['from', 'through']) {
    $(id).addEventListener('focus', () => {
      if (updateDateBounds()) {
        render();
        paintHint();
        persist();
      }
    });
    $(id).addEventListener('input', () => {
      paintHint();
      syncDateText();
    });
    $(id).addEventListener('change', (event) => changeDates(event.target.id));
  }
  const calendar = RailWatchCalendar.bind({
    $,
    updateDateBounds() {
      if (updateDateBounds()) {
        render();
        paintHint();
        persist();
      }
    },
    onChange: changeDates,
    watch: {
      getDates() {
        let available = [];
        try {
          available = config().dates.map(RailWatchBooking.day);
        } catch {}
        return {
          available,
          selected: (watchDates || []).map(RailWatchBooking.day),
          disabled: busy || watchActive() || $('bookingTripType').value === '2',
        };
      },
      onChange(iso) {
        const chosen = new Set(watchDates || []);
        const date = key(iso);
        if (chosen.has(date)) chosen.delete(date);
        else chosen.add(date);
        watchDates = config().dates.filter((day) => chosen.has(day));
        bookingChoices.outbound.scope = JSON.stringify([
          route.origin.id,
          route.destination.id,
          watchDates.length === 1 ? watchDates[0] : watchDates.join(','),
        ]);
        saveBookingSetup();
      },
    },
  });
  $('filter').addEventListener('change', (event) => {
    if (!filterValue()) {
      event.target.checked = true;
      status('Keep at least one class selected.');
      return;
    }
    render();
    persist();
  });
  $('interval').addEventListener('change', () => {
    schedule();
    persist();
  });
  $('refresh').onclick = () => scan(true);
  $('pause').onclick = () => {
    paused = !paused;
    if (paused) clearDateCheck();
    schedule();
    render();
  };
  $('close').onclick = () => {
    if ($('dateCalendar').open) $('dateCalendar').close();
    if ($('bookingSetupDialog').open) $('bookingSetupDialog').close();
    shell.hidden = true;
    launcher.hidden = false;
    clearTimeout(timer);
    clearDateCheck();
    nextCheck = null;
    status();
    launcher.focus();
  };
  launcher.onclick = open;
  root.addEventListener('click', (event) => {
    if (!event.target.closest('.watch-quick-menu, .watch-quick-trigger')) closeQuickMenus();
    if (event.target.closest('[data-stations-retry]')) {
      const input = event.target.closest('.ac').querySelector('input');
      input.focus();
      open();
      acPopulate(input);
      return;
    }
    if (!event.target.closest('#alertTrainPicker')) $('alertTrainPicker').open = false;
    const palette = event.target.closest('[data-action="accent"]');
    if (palette) {
      transitionTheme();
      applyAccent(palette.dataset.val);
      persist();
      return;
    }
    const cadence = event.target.closest('[data-action="cadence"]');
    if (cadence) {
      $('interval').value = String(Number(cadence.dataset.val) * 60000);
      root
        .querySelectorAll('[data-action="cadence"]')
        .forEach((button) => button.toggleAttribute('data-on', button === cadence));
      schedule();
      persist();
      return;
    }
    const toggle = event.target.closest('[data-action="alert-toggle"]');
    if (toggle) {
      setAlertState(toggle.getAttribute('aria-checked') !== 'true');
      return;
    }
    const addDate = event.target.closest('[data-action="activate-date"]');
    if (addDate) {
      const [day, month, year] = addDate.dataset.dmy.split('/');
      $('through').value = `${year}-${month}-${day.padStart(2, '0')}`;
      changeDates('through');
      return;
    }
    const cell = event.target.closest('[data-action="cell"]');
    if (cell) {
      showDetail(cell.dataset.date, cell.dataset.train);
      persist();
      return;
    }
    const book = event.target.closest('[data-book-train]');
    if (book) {
      bookTrain(book);
      return;
    }
    if (event.target.closest('[data-recheck-empty]')) scan(true);
  });
  root.addEventListener('change', (event) => {
    const choice = event.target.closest('[data-watch-leg]');
    if (choice && !busy && !watchActive()) {
      const leg = choice.dataset.watchLeg;
      const alternatives = bookingChoices[leg].alternatives;
      const index = alternatives.findIndex(
        (c) => c.train === choice.dataset.train && c.coachId === choice.dataset.coachId,
      );
      if (choice.checked && index < 0)
        alternatives.push({
          train: choice.dataset.train,
          coachId: choice.dataset.coachId,
          coachLabel: '',
        });
      else if (!choice.checked && index >= 0) alternatives.splice(index, 1);
      saveBookingSetup();
      const selector = `[data-watch-leg="${leg}"][data-train="${choice.dataset.train}"][data-coach-id="${choice.dataset.coachId}"]`;
      root.querySelector(selector)?.focus();
      return;
    }
    if (event.target.matches('[data-chk-all]')) {
      $('alertTrains').value = event.target.checked ? '' : 'none';
      renderAlertTrains();
      saveAlerts();
      return;
    }
    const train = event.target.closest('[data-alert-train]');
    if (train) {
      const numbers = alertTrainNumbers();
      const selected = selectedAlertTrains(numbers);
      if (train.checked) selected.add(train.dataset.alertTrain);
      else selected.delete(train.dataset.alertTrain);
      $('alertTrains').value =
        selected.size === 0
          ? 'none'
          : numbers.every((number) => selected.has(number))
            ? ''
            : [...selected].join(',');
      renderAlertTrains();
      $('alertTrainOptions')
        .querySelector(`[data-alert-train="${train.dataset.alertTrain}"]`)
        ?.focus();
      saveAlerts();
    }
  });
  root.addEventListener('mousedown', (event) => {
    const item = event.target.closest('.ac-item');
    if (!item || item.hasAttribute?.('data-stations-retry')) return;
    event.preventDefault();
    const input = item.closest('.ac').querySelector('input');
    input.value = item.dataset.fill;
    item.closest('.ac-list').hidden = true;
    input.setAttribute('aria-expanded', 'false');
    changeRoute();
  });
  root.addEventListener('focusout', (event) => {
    const ac = event.target.closest('.ac');
    if (ac)
      setTimeout(() => {
        if (!ac.contains(root.activeElement)) {
          ac.querySelector('.ac-list').hidden = true;
          ac.querySelector('input').setAttribute('aria-expanded', 'false');
        }
      }, 0);
  });
  root.addEventListener('keydown', (event) => {
    const input = event.target.closest('.ac input');
    const list = input?.closest('.ac').querySelector('.ac-list');
    if (event.key === 'Escape') {
      if ($('dateCalendar').open || $('bookingSetupDialog').open) return;
      if ($('alertTrainPicker').open) {
        $('alertTrainPicker').open = false;
        return;
      }
      if (list && !list.hidden) {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      } else $('close').click();
      return;
    }
    if (!list || list.hidden) return;
    const items = [...list.querySelectorAll('.ac-item')];
    const current = items.findIndex((item) => item.getAttribute('aria-selected') === 'true');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next =
        current < 0
          ? event.key === 'ArrowDown'
            ? 0
            : items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((item, index) => item.setAttribute('aria-selected', String(index === next)));
      items[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && current >= 0) {
      event.preventDefault();
      input.value = items[current].dataset.fill;
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      changeRoute();
    }
  });
  async function bookTrain(button) {
    if (busy) return;
    if (watchActive()) {
      status('Cancel the active watch before opening a coach manually.');
      return;
    }
    if ($('bookingTripType').value === '2') {
      renderWatch();
      $('watchDate').value = button.dataset.bookDate;
      renderWatch();
      bookingChoices.outbound = {
        scope: JSON.stringify([route.origin.id, route.destination.id, button.dataset.bookDate]),
        alternatives: [
          { train: button.dataset.bookTrain, coachId: button.dataset.bookCoach, coachLabel: '' },
        ],
      };
      renderWatch();
      bookingError('Choose the return train and coach, then use Book now or start a watch.');
      $('bookingSetupDialog').showModal();
      return;
    }
    let settings;
    let profiles;
    try {
      settings = config();
      profiles = passengerProfiles();
      const error = RailWatchBooking.validatePassengers(profiles);
      if (error) {
        status(error);
        return;
      }
    } catch (error) {
      status(error.message);
      return;
    }
    busy = true;
    setRouteDisabled(true);
    $('refresh').disabled = true;
    button.disabled = true;
    clearTimeout(timer);
    try {
      await runtime.storage.local.set({ railWatchPassengers: profiles });
      status('Rechecking this coach before opening D-Ticket…');
      const result = await scanner.verify(
        settings,
        button.dataset.bookDate,
        button.dataset.bookTrain,
        {
          id: button.dataset.bookCoach,
          class: button.dataset.bookClass,
          type: button.dataset.bookType,
          air: button.dataset.bookAir,
        },
      );
      const row = data.find(
        (item) => item.date === button.dataset.bookDate && item.train === button.dataset.bookTrain,
      );
      if (row) {
        row.coaches = result.coaches;
        row.checkedAt = result.checkedAt;
        render();
        await persist();
      }
      const available =
        result.coaches.find((coach) => coach.id === button.dataset.bookCoach)?.count || 0;
      if (!result.available || available < profiles.length) {
        busy = false;
        schedule();
        status(
          'This coach has ' +
            available +
            ' seat' +
            (available === 1 ? '' : 's') +
            '. You need ' +
            profiles.length +
            ' for everyone.',
        );
        return;
      }
      const opened = await runtime.runtime.sendMessage({
        type: 'rail-watch-booking',
        passengers: profiles,
        params: {
          provinceStartId: settings.origin,
          provinceEndId: settings.destination,
          dateStart: button.dataset.bookDate,
          trainNo: button.dataset.bookTrain,
          coachId: button.dataset.bookCoach,
          autoFill: !profiles.some((profile) => profile.mode === 'manual'),
          seatCount: profiles.length,
          preferLowerBerths: $('preferLowerBerths').checked,
        },
      });
      if (opened?.error) throw Error(opened.error);
      busy = false;
      schedule();
      if (opened?.message) status(opened.message);
    } catch (error) {
      busy = false;
      failed(error);
    } finally {
      busy = false;
      $('refresh').disabled = false;
      setRouteDisabled(false);
      button.disabled = false;
    }
  }

  async function open() {
    await restored;
    shell.hidden = false;
    launcher.hidden = true;
    render();
    updateSignInWarning();
    requestAnimationFrame(fitMatrix);
    if (!stations.length && stationState.status !== 'loading') {
      stationState = { status: 'loading', error: '' };
      status('Loading railway stations…');
      try {
        const stationRows = await scanner.stations();
        if (!stationRows.length) throw Error('No stations returned.');
        stations = stationRows.map((station) => ({
          id: String(station.stationId),
          name: station.stationNameEn || station.stationNameTh,
          th: station.stationNameTh || '',
        }));
        stationState = { status: 'ready', error: '' };
        if (['origin', 'destination'].includes(root.activeElement?.id))
          acPopulate(root.activeElement, root.activeElement.dataset.browse === 'true');
        schedule(lastCheck ? Date.parse(lastCheck) : null);
      } catch (error) {
        stationState = { status: 'error', error: error.message };
        if (['origin', 'destination'].includes(root.activeElement?.id))
          acPopulate(root.activeElement, root.activeElement.dataset.browse === 'true');
        if (error.retryAt) failed(error);
        else {
          schedule(lastCheck ? Date.parse(lastCheck) : null);
          status('Stations could not load. Use Retry in the station field.');
        }
      }
    } else schedule(lastCheck ? Date.parse(lastCheck) : null);
  }
  runtime.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.railWatchAlertSettings) {
      const settings = changes.railWatchAlertSettings.newValue;
      const current = alertSettings();
      if (
        !settings ||
        ['enabled', 'trains', 'minimum'].some((key) => current[key] !== settings[key])
      )
        restoreAlertSettings(settings);
    }
    if (changes.railWatchBookingWatch) {
      bookingWatch = RailWatchWatch.upgrade(changes.railWatchBookingWatch.newValue);
      setRouteDisabled(busy);
    }
    if (changes.railWatchAvailabilityLog) renderLog(changes.railWatchAvailabilityLog.newValue);
    const shared = changes.railWatchShared?.newValue;
    if (shared && !busy) {
      try {
        if (scanner.covers(shared, config())) {
          data = shared.rows;
          dataFilter = JSON.parse(shared.key)[4];
          lastCheck = new Date(shared.at).toISOString();
          rememberResults(config().dates);
          renderAlertTrains();
          render();
          schedule();
        }
      } catch {}
    }
    const cooldown = changes.railWatchCooldown?.newValue;
    if (cooldown?.until > Date.now()) {
      cooldownUntil = cooldown.until;
      if (!busy) {
        schedule();
        status(
          'Rate-limit cooldown until ' +
            new Date(cooldownUntil).toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok' }) +
            ' Bangkok',
        );
      }
    }
  });
  runtime.runtime.onMessage.addListener((message) => {
    if (message.type === 'rail-watch-open') open();
  });

  const restored = (async () => {
    try {
      const stored = await runtime.storage.local.get([
        'railWatch',
        'railWatchShared',
        'railWatchAlertSettings',
        'railWatchAvailabilityLog',
        'railWatchPassengers',
        'railWatchPassenger',
        'railWatchBookingWatch',
        'railWatchBookingSetup',
      ]);
      bookingWatch = RailWatchWatch.upgrade(stored.railWatchBookingWatch) || null;
      $('bookingTripType').value = stored.railWatchBookingSetup?.tripType === '2' ? '2' : '1';
      $('returnDate').value = stored.railWatchBookingSetup?.returnDate || '';
      $('preferLowerBerths').checked = stored.railWatchBookingSetup?.preferLowerBerths !== false;
      if (
        Array.isArray(stored.railWatchBookingSetup?.departureDates) &&
        typeof stored.railWatchBookingSetup.dateScope === 'string'
      ) {
        watchDates = stored.railWatchBookingSetup.departureDates.filter(
          (date) => typeof date === 'string' && RailWatchBooking.day(date),
        );
        watchDateScope = stored.railWatchBookingSetup.dateScope;
      }
      for (const leg of ['outbound', 'return']) {
        const savedChoices = stored.railWatchBookingSetup?.choices?.[leg];
        if (typeof savedChoices?.scope === 'string' && Array.isArray(savedChoices.alternatives))
          bookingChoices[leg] = {
            scope: savedChoices.scope,
            alternatives: savedChoices.alternatives.filter(
              (choice) => typeof choice?.train === 'string' && typeof choice.coachId === 'string',
            ),
          };
      }
      passengers =
        Array.isArray(stored.railWatchPassengers) &&
        stored.railWatchPassengers.length >= 1 &&
        stored.railWatchPassengers.length <= 4
          ? stored.railWatchPassengers
          : stored.railWatchPassenger
            ? [stored.railWatchPassenger]
            : [{ mode: 'account' }];
      loadPassenger();
      renderLog(stored.railWatchAvailabilityLog);
      restoreAlertSettings(stored.railWatchAlertSettings);
      const saved = stored.railWatch;
      if (saved) {
        if (saved.route?.origin?.id && saved.route?.destination?.id) route = saved.route;
        data = saved.schema === 2 && Array.isArray(saved.data) ? saved.data : [];
        dataFilter = saved.dataFilter || saved.filter || 'all';
        routeResults = saved.routeResults || {};
        lastCheck = saved.schema === 2 ? saved.lastCheck : null;
        selected = saved.selected || null;
        dismissedWatchId = saved.dismissedWatchId || null;
        for (const id of ['from', 'through', 'interval']) if (saved[id]) $(id).value = saved[id];
        if (saved.filter) restoreFilter(saved.filter);
        applyTheme(saved.theme === 'light' ? 'light' : 'dark');
        applyAccent(saved.accent || 'brass');
        applySidebar(Boolean(saved.sidebarCollapsed));
        applyHistory(Boolean(saved.historyCollapsed));
        $('origin').value = route.origin?.name || '';
        $('destination').value = route.destination?.name || '';
      }
      const params = preview ? new URLSearchParams(location.search) : null;
      if (params?.has('theme')) applyTheme(params.get('theme') === 'light' ? 'light' : 'dark');
      if (params?.has('accent')) applyAccent(params.get('accent'));
      if (params?.has('start')) $('from').value = params.get('start');
      if (params?.has('end')) $('through').value = params.get('end');
      applyAccent(shell.dataset.accent || 'brass');
      updateDateBounds();
      syncDateText();
      const selectedCadence = String(Number($('interval').value) / 60000);
      root
        .querySelectorAll('[data-action="cadence"]')
        .forEach((button) =>
          button.toggleAttribute('data-on', button.dataset.val === selectedCadence),
        );
      const shared = stored.railWatchShared;
      if (
        shared &&
        route.origin &&
        route.destination &&
        scanner.covers(shared, config()) &&
        shared.at >= (Date.parse(lastCheck) || 0)
      ) {
        data = shared.rows;
        dataFilter = JSON.parse(shared.key)[4];
        lastCheck = new Date(shared.at).toISOString();
      }
    } catch (error) {
      console.error('Could not restore seat dashboard preferences', error);
    }
    rememberResults();
    renderAlertTrains();
    render();
    setRouteDisabled(false);
    paintHint();
    status();
  })();
  updateDateBounds();
  syncDateText();
  window.addEventListener('resize', fitMatrix);
  window.addEventListener('load', fitMatrix);
  document.fonts?.ready.then(fitMatrix);
  root.addEventListener(
    'scroll',
    (event) => {
      const element = event.target;
      if (!element.classList?.contains('hist-scroll')) return;
      element.classList.add('is-scrolling');
      clearTimeout(element.scrollTimer);
      element.scrollTimer = setTimeout(() => element.classList.remove('is-scrolling'), 700);
    },
    true,
  );
  function showTooltip(event) {
    const target = event.target.closest('[data-tip],[title]');
    if (target?.title) {
      target.dataset.tip = target.title;
      target.removeAttribute('title');
    }
    if (
      event.target.closest('.mx-cell') ||
      event.target.closest('button,input,select,textarea')?.disabled ||
      (watchActive() && event.target.closest('[data-watch-lock]'))
    ) {
      hideTooltip();
      return;
    }
    if (!target?.dataset.tip) return;
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'sw-tip';
      tooltip.setAttribute('popover', 'manual');
      tooltip.setAttribute('role', 'tooltip');
      tooltip.setAttribute('aria-hidden', 'true');
      shell.append(tooltip);
    }
    tooltip.textContent = target.dataset.tip;
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    tooltip.classList.add('on');
    tooltip.setAttribute('aria-hidden', 'false');
    const rect = target.getBoundingClientRect();
    const top = rect.top - tooltip.offsetHeight - 6;
    tooltip.style.top = (top < 6 ? rect.bottom + 6 : top) + 'px';
    tooltip.style.left =
      Math.max(
        8,
        Math.min(
          rect.left + (rect.width - tooltip.offsetWidth) / 2,
          innerWidth - tooltip.offsetWidth - 8,
        ),
      ) + 'px';
  }
  root.addEventListener('pointerover', showTooltip);
  root.addEventListener('focusin', showTooltip);
  function hideTooltip() {
    tooltip?.hidePopover();
    tooltip?.classList.remove('on');
    tooltip?.setAttribute('aria-hidden', 'true');
  }
  root.addEventListener('pointerout', (event) => {
    if (event.target.closest('[data-tip]')) hideTooltip();
  });
  root.addEventListener('pointerdown', hideTooltip);
  root.addEventListener('focusout', hideTooltip);
  root.addEventListener('scroll', hideTooltip, true);
  if (runtime.autoOpen) restored.then(open);
})();
