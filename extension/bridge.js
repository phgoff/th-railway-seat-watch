(() => {
  const searchPrefix = '#rail-watch-search=';
  if (location.hash.startsWith(searchPrefix)) {
    try {
      const search = JSON.parse(decodeURIComponent(location.hash.slice(searchPrefix.length)));
      if (
        !/^\d+$/.test(search.provinceStartId) ||
        !/^\d+$/.test(search.provinceEndId) ||
        !/^\d{1,2}\/\d{2}\/\d{4}$/.test(search.dateStart) ||
        !/^\d+$/.test(search.trainNo) ||
        (search.preferLowerBerths !== undefined && typeof search.preferLowerBerths !== 'boolean') ||
        !Number.isFinite(search.expires) ||
        search.expires < Date.now()
      )
        return;
      if (
        !Number.isInteger(search.seatCount || 1) ||
        (search.seatCount || 1) < 1 ||
        (search.seatCount || 1) > 4
      )
        return;
      if (search.returnLeg && RailWatchBooking.validateReturn(search.dateStart, search.returnLeg))
        return;
      history.replaceState(null, '', location.pathname + location.search);
      const form = document.createElement('form');
      form.method = 'POST';
      form.action =
        '/DTicketPublicWeb/booking/booking#rail-watch=' +
        encodeURIComponent(JSON.stringify(search));
      for (const [name, value] of Object.entries({
        tripType: search.returnLeg ? '2' : '1',
        provinceStart: search.provinceStartId,
        provinceEnd: search.provinceEndId,
        'date-start': search.dateStart,
        'date-end': search.returnLeg?.date || '',
        seatperson: String(search.seatCount || 1),
        lineId: '0',
      })) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      form.submit();
      form.remove();
    } catch {}
    return;
  }
  // Continue the user's chosen route, train and coach through D-Ticket's own buttons.
  let target;
  try {
    if (location.hash.startsWith('#rail-watch='))
      target = JSON.parse(decodeURIComponent(location.hash.slice(12)));
  } catch {}
  if (
    target &&
    Number.isFinite(target.expires) &&
    (target.preferLowerBerths === undefined || typeof target.preferLowerBerths === 'boolean') &&
    location.pathname === '/DTicketPublicWeb/booking/booking'
  ) {
    history.replaceState(null, '', location.pathname + location.search);
    const deadline = Math.min(target.expires, Date.now() + 120000);
    const select = () => {
      if (Date.now() > deadline) return;
      if (
        typeof sessionDataBooking === 'undefined' ||
        typeof departureTrips === 'undefined' ||
        !departureTrips.length ||
        typeof chooseTrip !== 'function'
      ) {
        setTimeout(select, 250);
        return;
      }
      if (
        String(sessionDataBooking.provinceStartId) !== target.provinceStartId ||
        String(sessionDataBooking.provinceEndId) !== target.provinceEndId ||
        sessionDataBooking.dateStart !== target.dateStart
      )
        return;
      if (
        target.returnLeg &&
        (RailWatchBooking.validateReturn(target.dateStart, target.returnLeg) ||
          String(sessionDataBooking.tripType) !== '2' ||
          sessionDataBooking.dateEnd !== target.returnLeg.date)
      )
        return;
      const index = departureTrips.findIndex((trip) => String(trip.trainNo) === target.trainNo);
      if (index >= 0 && typeof chooseTrip === 'function') {
        chooseTrip(index, true);
        if (target.returnLeg) selectReturnTrain();
        else if (target.coachId) selectCoach(true);
      }
    };
    const selectReturnTrain = () => {
      if (Date.now() > deadline) return;
      if (
        typeof arrivalTrips === 'undefined' ||
        !arrivalTrips.length ||
        (typeof step !== 'undefined' && String(step) !== '11') ||
        window.jQuery?.active
      ) {
        setTimeout(selectReturnTrain, 250);
        return;
      }
      const index = arrivalTrips.findIndex(
        (trip) => String(trip.trainNo) === target.returnLeg.train,
      );
      if (index < 0) return;
      chooseTrip(index, false);
      selectCoach(true);
    };
    const selectCoach = (departure) => {
      if (Date.now() > deadline) return;
      const coaches = departure
        ? typeof departureTrainCoachs === 'undefined'
          ? null
          : departureTrainCoachs
        : typeof arrivalTrainCoachs === 'undefined'
          ? null
          : arrivalTrainCoachs;
      if (
        !coaches ||
        typeof divTrainCoach === 'undefined' ||
        (typeof step !== 'undefined' && String(step) !== (departure ? '20' : '21'))
      ) {
        setTimeout(() => selectCoach(departure), 250);
        return;
      }
      const coachId = departure ? target.coachId : target.returnLeg.coachId;
      const index = coaches.findIndex(
        (coach) =>
          [coach.coachId, coach.coachNo, coach.coachLayoutId, coach.coachTypeId]
            .map((value) => String(value ?? ''))
            .join('|') === coachId,
      );
      const cards = document.querySelector(divTrainCoach)?.children;
      const card = index >= 0 ? cards?.[index] : null;
      if (!card) {
        setTimeout(() => selectCoach(departure), 250);
        return;
      }
      card.style.outline = '3px solid #1a7f4b';
      card.setAttribute('data-rail-watch-coach', coachId);
      card.scrollIntoView({ block: 'center' });
      const button = card.querySelector('.choose-bt[onclick^="chooseTrainCoach("]');
      if (
        coaches[index].availableSeatCount >= (target.seatCount || 1) &&
        button &&
        !button.disabled &&
        !button.closest('.disabled-booking-box')
      ) {
        button.click();
        if (departure && target.returnLeg) selectCoach(false);
        else if (target.autoFill) RailWatchBooking.start(target);
      }
    };
    select();
  }
  const endpoints = {
    getStation: { path: 'home/Home/getStation', fields: ['LineId'] },
    getTrip: {
      path: 'booking/booking/getTrip',
      fields: ['tripType', 'provinceStartId', 'provinceEndId', 'dateStart', 'dateEnd'],
    },
    getTrainCoach: {
      path: 'booking/booking/getTrainCoach',
      fields: ['tripId', 'provinceStartId', 'provinceEndId'],
    },
  };
  document.addEventListener('rail-watch-request', (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (typeof message?.id !== 'string' || !Object.hasOwn(endpoints, message.endpoint)) return;
    const endpoint = endpoints[message.endpoint];
    const reply = (payload) =>
      document.dispatchEvent(
        new CustomEvent('rail-watch-response', {
          detail: JSON.stringify({ id: message.id, ...payload }),
        }),
      );
    if (!window.SmartUtil || !window.jQuery) {
      reply({ error: 'D-Ticket is still loading. Try again in a moment.' });
      return;
    }
    const payload = window.jQuery('#dummyFrm').serializeArray();
    for (const field of endpoint.fields) {
      const value = message.params?.[field];
      if (typeof value !== 'string' || value.length > 100) {
        reply({ error: 'Invalid search parameter: ' + field });
        return;
      }
      payload.push({ name: field, value });
    }
    // Match the site's form payload and view-state updates, while retaining HTTP status/Retry-After.
    const values = new URLSearchParams();
    for (const field of payload) values.append(field.name, field.value ?? '');
    for (const [name, value] of Object.entries(window.SmartUtil.hiddenParams || {}))
      if (!values.has(name)) values.append(name, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);
    fetch(new URL(endpoint.path, 'https://dticket.railway.co.th/DTicketPublicWeb/'), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-cache',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: values,
    })
      .then(async (response) => {
        const header = response.headers.get('Retry-After');
        const seconds = header === null ? NaN : Number(header);
        const retryAt = Number.isFinite(seconds)
          ? Date.now() + Math.max(0, seconds) * 1000
          : Date.parse(header) || 0;
        if (!response.ok) {
          reply({ error: 'HTTP ' + response.status, httpStatus: response.status, retryAt });
          return;
        }
        const result = await response.json();
        if (result.viewStateHolder)
          window.SmartUtil.hiddenParams.viewStateHolder = result.viewStateHolder;
        if (result.errorCode !== 'S_SUCCESS') {
          reply({
            error: result.errorCode || 'Invalid railway response',
            httpStatus: response.status,
            retryAt,
          });
          return;
        }
        reply({ result: { errorCode: result.errorCode, data: result.data } });
      })
      .catch((error) =>
        reply({
          error: error.name === 'AbortError' ? 'Request timed out after 40 seconds' : error.message,
        }),
      )
      .finally(() => clearTimeout(timeout));
  });
})();
