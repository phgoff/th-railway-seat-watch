// Paste into the D-Ticket browser console. Omitted options use the current search.
async function scanAvailability(options = {}) {
  const search = typeof sessionDataBooking === 'undefined' ? {} : sessionDataBooking;
  const originId = String(options.originId ?? search.provinceStartId ?? '');
  const destinationId = String(options.destinationId ?? search.provinceEndId ?? '');
  if (!/^\d+$/.test(originId) || !/^\d+$/.test(destinationId) || originId === destinationId) {
    throw new Error(
      'Choose different origin and destination stations, or pass originId and destinationId.',
    );
  }
  function parseDate(value) {
    const text = String(value ?? '');
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    const local = /^(\d{1,2})\/(\d{2})\/(\d{4})$/.exec(text);
    const parts = iso
      ? [+iso[1], +iso[2], +iso[3]]
      : local
        ? [+local[3], +local[2], +local[1]]
        : null;
    if (!parts) throw new Error('Supply dates as YYYY-MM-DD or DD/MM/YYYY.');
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (
      date.getUTCFullYear() !== parts[0] ||
      date.getUTCMonth() + 1 !== parts[1] ||
      date.getUTCDate() !== parts[2]
    )
      throw new Error('Invalid departure date: ' + text);
    return date;
  }
  const start = parseDate(options.from ?? search.dateStart);
  const end = parseDate(options.through ?? options.from ?? search.dateStart);
  if (end < start || (end - start) / 86400000 > 30)
    throw new Error('Choose an inclusive date range of up to 31 days.');
  const request = (endpoint, params) =>
    new Promise((resolve, reject) => {
      const data = jQuery('#dummyFrm').serializeArray();
      for (const [name, value] of Object.entries(params)) data.push({ name, value });
      const timeout = setTimeout(
        () => reject(new Error('Request timed out after 45 seconds')),
        45000,
      );
      const fail = (error) => {
        clearTimeout(timeout);
        reject(new Error(error.errorCode || error.message || 'Railway request failed'));
      };
      try {
        SmartUtil.ajax(`booking/booking/${endpoint}`, data, {
          showLoadingMask: false,
          onSuccess: (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          onError: fail,
          error: fail,
        });
      } catch (error) {
        fail(error);
      }
    });
  const results = [];
  for (let day = start; day <= end; day = new Date(+day + 86400000)) {
    const date = `${day.getUTCDate()}/${String(day.getUTCMonth() + 1).padStart(2, '0')}/${day.getUTCFullYear()}`;
    const trips = await request('getTrip', {
      tripType: '1',
      provinceStartId: originId,
      provinceEndId: destinationId,
      dateStart: date,
      dateEnd: '',
    });
    if (trips.errorCode !== 'S_SUCCESS') throw new Error(`${date}: ${trips.errorCode}`);
    for (const trip of trips.data || []) {
      const coaches = await request('getTrainCoach', {
        tripId: String(trip.tripId),
        provinceStartId: originId,
        provinceEndId: destinationId,
      });
      if (coaches.errorCode !== 'S_SUCCESS')
        throw new Error(`${date}, train ${trip.trainNo}: ${coaches.errorCode}`);
      results.push({
        date,
        originId,
        destinationId,
        checkedAt: new Date().toISOString(),
        trip,
        coaches: coaches.data.results,
      });
      console.log(
        date,
        trip.trainNo,
        coaches.data.results.map((c) => ({
          class: c.coachClass,
          type: c.coachSeatTypeEn,
          air: c.coachAirTypeEn,
          available: c.availableSeatCount,
        })),
      );
    }
  }
  return results;
}
