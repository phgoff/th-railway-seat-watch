globalThis.RailWatchWatch = {
  upgrade(watch) {
    if (!watch) return watch;
    const upgradeLeg = (leg) => {
      const { train, coachId, coachLabel, ...rest } = leg;
      return {
        ...rest,
        alternatives: rest.alternatives || [{ train, coachId, coachLabel }],
      };
    };
    const upgraded = upgradeLeg(watch);
    if (watch.returnLeg) upgraded.returnLeg = upgradeLeg(watch.returnLeg);
    if (['cancelled', 'opened', 'error'].includes(upgraded.status)) {
      const { passenger, passengers, ...rest } = upgraded;
      return { ...rest, seatCount: passengers?.length || rest.seatCount || (passenger ? 1 : 0) };
    }
    if (upgraded.passengers || !['armed', 'opening'].includes(upgraded.status)) return upgraded;
    const { passenger, ...rest } = upgraded;
    return { ...rest, passengers: [passenger] };
  },
  validate(target, requireAutomatic = true) {
    const validAlternatives = (leg) => {
      if (
        !Array.isArray(leg.alternatives) ||
        leg.alternatives.length < 1 ||
        leg.alternatives.length > 100 ||
        ['train', 'coachId', 'coachLabel'].some((field) => field in leg)
      )
        return false;
      const choices = new Set();
      return leg.alternatives.every((choice) => {
        if (
          typeof choice?.train !== 'string' ||
          !/^\d+$/.test(choice.train) ||
          typeof choice.coachId !== 'string' ||
          !/^\d+\|\d+\|\d+\|\d+$/.test(choice.coachId)
        )
          return false;
        const key = JSON.stringify([choice.train, choice.coachId]);
        if (choices.has(key)) return false;
        choices.add(key);
        return true;
      });
    };
    if (
      !target ||
      typeof target.origin !== 'string' ||
      !/^\d+$/.test(target.origin) ||
      typeof target.destination !== 'string' ||
      !/^\d+$/.test(target.destination) ||
      target.origin === target.destination ||
      !RailWatchBooking.day(target.date) ||
      !validAlternatives(target)
    )
      return 'Choose a date, train and coach from the current search.';
    if (target.preferLowerBerths !== undefined && typeof target.preferLowerBerths !== 'boolean')
      return 'Choose whether to prefer lower berths.';
    if (
      target.dates !== undefined &&
      (target.returnLeg ||
        !Array.isArray(target.dates) ||
        target.dates.length < 1 ||
        target.dates.length > 31 ||
        target.dates[0] !== target.date ||
        new Set(target.dates).size !== target.dates.length ||
        target.dates.some((date) => !RailWatchBooking.day(date)) ||
        target.dates.some(
          (date, index) =>
            index > 0 &&
            RailWatchBooking.day(date) <= RailWatchBooking.day(target.dates[index - 1]),
        ))
    )
      return 'Choose up to 31 different departure dates in date order for a one-way watch.';
    if (target.returnLeg) {
      if (target.returnLeg.dates !== undefined) return 'Choose a single return date.';
      if (
        !RailWatchBooking.day(target.returnLeg.date) ||
        RailWatchBooking.day(target.returnLeg.date) < RailWatchBooking.day(target.date)
      )
        return 'Choose a return date on or after departure.';
      if (!validAlternatives(target.returnLeg)) return 'Choose a return train and coach.';
    }
    if (
      requireAutomatic &&
      Array.isArray(target.passengers) &&
      target.passengers.some((passenger) => passenger?.mode === 'manual')
    )
      return 'Choose automatic filling for every passenger in a watched booking.';
    return RailWatchBooking.validatePassengers(target.passengers);
  },
  resolve(target, checks, notBefore = 0, now = Date.now()) {
    if (this.validate(target, false) || !Number.isFinite(notBefore) || !Number.isFinite(now))
      return null;
    const legs = [
      target,
      ...(target.returnLeg
        ? [{ ...target.returnLeg, origin: target.destination, destination: target.origin }]
        : []),
    ];
    if (!Array.isArray(checks) || checks.length !== legs.length) return null;
    const selections = [];
    const recent = (at) => Number.isFinite(at) && at >= notBefore && at <= now && now - at <= 60000;
    for (const [index, leg] of legs.entries()) {
      const check = checks[index];
      if (
        check?.fresh !== true ||
        !recent(check.at) ||
        check.config?.origin !== leg.origin ||
        check.config?.destination !== leg.destination ||
        !Array.isArray(check.config?.dates) ||
        !(leg.dates || [leg.date]).every((date) => check.config.dates.includes(date)) ||
        !Array.isArray(check.rows)
      )
        return null;
      let selected;
      let selectedDate;
      for (const date of leg.dates || [leg.date]) {
        selected = leg.alternatives.find((choice) =>
          check.rows.some(
            (row) =>
              row?.date === date &&
              row.train === choice.train &&
              recent(Date.parse(row.checkedAt)) &&
              Array.isArray(row.coaches) &&
              row.coaches.some(
                (coach) =>
                  coach?.id === choice.coachId &&
                  Number.isFinite(coach.count) &&
                  coach.count >= target.passengers.length,
              ),
          ),
        );
        if (selected) {
          selectedDate = date;
          break;
        }
      }
      if (!selected) return null;
      selections.push({
        ...(target.dates ? { date: selectedDate } : {}),
        train: selected.train,
        coachId: selected.coachId,
        coachLabel: selected.coachLabel,
      });
    }
    return {
      ...selections[0],
      ...(target.returnLeg ? { returnLeg: { date: target.returnLeg.date, ...selections[1] } } : {}),
    };
  },
};
