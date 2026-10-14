globalThis.RailWatchBooking = {
  day(date) {
    if (typeof date !== 'string' || !/^\d{1,2}\/\d{2}\/\d{4}$/.test(date)) return '';
    const [day, month, year] = date.split('/');
    const iso = `${year}-${month}-${day.padStart(2, '0')}`;
    const parsed = new Date(iso + 'T00:00:00Z');
    return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === iso ? iso : '';
  },
  validateReturn(date, leg) {
    if (!leg || !this.day(date) || !this.day(leg.date) || this.day(leg.date) < this.day(date))
      return 'Choose a return date on or after departure.';
    if (!/^\d+$/.test(leg.train) || !/^\d+\|\d+\|\d+\|\d+$/.test(leg.coachId))
      return 'Choose a return train and coach.';
    return '';
  },
  validate(profile) {
    if (profile?.mode === 'account' || profile?.mode === 'manual') return '';
    if (profile?.mode !== 'custom') return 'Choose a passenger.';
    for (const field of ['firstName', 'lastName', 'idCard', 'mobileNo']) {
      if (
        typeof profile[field] !== 'string' ||
        !profile[field].trim() ||
        profile[field].length > 100
      )
        return 'Complete the passenger name, ID and phone number.';
    }
    if (!['M', 'F'].includes(profile.gender) || !['N', 'Y'].includes(profile.foreignerFlag))
      return 'Choose the passenger gender and ID type.';
    const id = profile.idCard;
    if (profile.foreignerFlag === 'Y') {
      if (!/^[a-zA-Z0-9]{5,20}$/.test(id)) return 'Enter a valid passport number.';
    } else {
      if (
        !/^\d{13}$/.test(id) ||
        (11 -
          ([...id.slice(0, 12)].reduce((sum, digit, i) => sum + Number(digit) * (13 - i), 0) %
            11)) %
          10 !==
          Number(id[12])
      )
        return 'Enter a valid Thai ID number.';
    }
    if (!/^\d{10}$/.test(profile.mobileNo)) return 'Enter a 10-digit phone number.';
    if (
      typeof profile.email !== 'string' ||
      profile.email.length > 100 ||
      (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email))
    )
      return 'Enter a valid email address or leave it blank.';
    return '';
  },
  validatePassengers(passengers) {
    if (!Array.isArray(passengers) || passengers.length < 1 || passengers.length > 4)
      return 'Choose 1–4 passengers.';
    const ids = new Set();
    for (const [index, passenger] of passengers.entries()) {
      const error = this.validate(passenger);
      if (error) return 'Passenger ' + (index + 1) + ': ' + error;
      if (passenger.mode === 'account' && index !== 0)
        return 'Use the account holder only as passenger 1.';
      if (passenger.mode === 'custom') {
        const id = passenger.idCard.toUpperCase();
        if (ids.has(id)) return 'Each passenger needs a different ID or passport number.';
        ids.add(id);
      }
    }
    return '';
  },
  preferLowerBerth(seat, assigned, personNo = 1) {
    if (!assigned.value || assigned.value.includes(',') || typeof removeDataByUserId !== 'function')
      return;
    const buttons = [...document.querySelectorAll('.train-number-btn .trainCoach')];
    const currentButton = buttons.find((button) => button.classList.contains('active'));
    if (!currentButton) return;
    const bogey = String(Number(currentButton?.dataset.slideTo || 0) + 1);
    const seats = [...seat.querySelectorAll('.img-check[data-seat-id]')];
    const assignments = [...document.querySelectorAll('input[name^="data-seat-user-"]')];
    const selectedIds = new Set(
      assignments.flatMap((input) => input.value.split(',')).filter(Boolean),
    );
    const original = seats.find(
      (item) => item.dataset.bogeyNo === bogey && item.dataset.seatId === assigned.value,
    );
    const lower = (item) => item.dataset.seatTypeImg?.endsWith('/icon-lowerbunk-black.png');
    if (!original || lower(original) || original.dataset.status === 'reserved') return;
    const gender = typeof IsGenderRoomSeat === 'function' ? IsGenderRoomSeat(personNo) : null;
    const blockedRooms =
      gender === 'M'
        ? [
            typeof ladyRoomItems === 'undefined' ? null : ladyRoomItems,
            typeof bothMenAndLadyItems === 'undefined' ? null : bothMenAndLadyItems,
          ]
        : gender === 'F'
          ? [
              typeof menRoomItems === 'undefined' ? null : menRoomItems,
              typeof monkRoomItems === 'undefined' ? null : monkRoomItems,
              typeof bothMenAndLadyItems === 'undefined' ? null : bothMenAndLadyItems,
            ]
          : [];
    const candidate = seats
      .filter((item) => {
        if (
          !lower(item) ||
          !item.classList.contains('empty') ||
          item.dataset.status === 'reserved' ||
          !/^\d+$/.test(item.dataset.seatId)
        )
          return false;
        if (
          selectedIds.has(item.dataset.seatId) ||
          (assignments.length > 1 && item.dataset.bogeyNo !== bogey)
        )
          return false;
        const index = Number(item.dataset.bogeyNo) - 1;
        if (
          item.dataset.bogeyNo !== bogey &&
          !buttons.some((button) => Number(button.dataset.slideTo) === index)
        )
          return false;
        const room = item.dataset.roomNo;
        return (
          !room ||
          room === '-' ||
          (gender &&
            blockedRooms.every(
              (rooms) => Array.isArray(rooms?.[index]) && !rooms[index].includes(room),
            ))
        );
      })
      .sort((a, b) => Number(b.dataset.bogeyNo === bogey) - Number(a.dataset.bogeyNo === bogey))[0];
    if (!candidate) return;
    removeDataByUserId(personNo);
    if (candidate.dataset.bogeyNo !== bogey)
      buttons
        .find((button) => Number(button.dataset.slideTo) + 1 === Number(candidate.dataset.bogeyNo))
        .click();
    const active = buttons.find((button) => button.classList.contains('active'));
    if (String(Number(active?.dataset.slideTo || 0) + 1) === candidate.dataset.bogeyNo)
      candidate.click();
    if (assigned.value !== candidate.dataset.seatId) {
      if (currentButton && !currentButton.classList.contains('active')) currentButton.click();
      original.click();
    }
  },
  start(target) {
    let profiles,
      genderAdvanced = false,
      departureAssignments;
    const advancedSeats = new Set();
    const deadline = Math.min(target.expires, Date.now() + 120000);
    const receive = (event) => {
      try {
        const message = JSON.parse(event.detail);
        if (message.id === target.expires && !this.validatePassengers(message.passengers))
          profiles = message.passengers;
      } catch {}
    };
    document.addEventListener('rail-watch-passenger-response', receive);
    const stop = () => document.removeEventListener('rail-watch-passenger-response', receive);
    const visible = (selector) => {
      const element = document.querySelector(selector);
      return element?.getClientRects().length ? element : null;
    };
    const tick = () => {
      if (Date.now() > deadline) {
        stop();
        return;
      }
      const booking = typeof sessionDataBooking === 'undefined' ? null : sessionDataBooking;
      const count = target.seatCount || 1;
      if (
        !booking ||
        String(booking.tripType) !== (target.returnLeg ? '2' : '1') ||
        String(booking.provinceStartId) !== target.provinceStartId ||
        String(booking.provinceEndId) !== target.provinceEndId ||
        booking.dateStart !== target.dateStart ||
        (target.returnLeg && booking.dateEnd !== target.returnLeg.date) ||
        Number(booking.seatPerson) !== count ||
        (profiles && profiles.length !== count)
      ) {
        stop();
        return;
      }
      const legs = [
        { train: target.trainNo, coachId: target.coachId },
        ...(target.returnLeg ? [target.returnLeg] : []),
      ];
      if (
        legs.some((leg, index) => {
          const trip = booking.train?.trip?.[index];
          return (
            !trip ||
            String(trip.trainNo) !== leg.train ||
            [trip.coachId, trip.coachNo, trip.coachLayoutId, trip.coachTypeId]
              .map((value) => String(value ?? ''))
              .join('|') !== leg.coachId
          );
        })
      ) {
        stop();
        return;
      }
      if (!profiles) {
        document.dispatchEvent(
          new CustomEvent('rail-watch-passenger-request', {
            detail: JSON.stringify({ id: target.expires, bookingId: target.bookingId }),
          }),
        );
      } else if (profiles.some((profile) => profile.mode === 'manual')) {
        stop();
        return;
      } else if (!window.jQuery?.active) {
        const info = visible('#step-infomation');
        if (info && typeof clearDataMember === 'function' && typeof setDataMember === 'function') {
          const people = profiles.map((profile, index) =>
            profile.mode === 'account' ? booking.personal?.[index] : profile,
          );
          if (people.some((person) => !person?.firstName || !person?.lastName || !person?.idCard)) {
            stop();
            return;
          }
          for (const [index, person] of people.entries()) {
            clearDataMember(index + 1);
            setDataMember(person, index + 1);
            booking.personal[index] = person;
          }
          stop();
          return;
        }
        const gender = visible('#step-person-booking-gender');
        if (gender && !genderAdvanced) {
          const account = document.querySelector('#pdg_chkReservationId');
          if (account && account.checked !== (profiles[0].mode === 'account')) account.click();
          for (const [index, profile] of profiles.entries()) {
            const person = profile.mode === 'account' ? booking.memberInfo : profile;
            if (!person || !['M', 'F'].includes(person.gender)) {
              stop();
              return;
            }
            const radio = document.querySelector('#pdg_fGender' + person.gender + (index + 1));
            const hidden = document.querySelector('input[name="pdg_Gender' + (index + 1) + '"]');
            if (!radio || !hidden) {
              stop();
              return;
            }
            radio.checked = true;
            hidden.value = person.gender;
          }
          const captcha =
            typeof RecaptchaHelper !== 'undefined'
              ? RecaptchaHelper
              : typeof TurnstileHelper !== 'undefined'
                ? TurnstileHelper
                : null;
          if (!captcha?.isAutoSeatEnabled() || captcha.getResponse('autoSeatRecaptcha')) {
            const next = gender.querySelector('[onclick="nextToPersonBookingGender()"]');
            if (next && !next.disabled) {
              genderAdvanced = true;
              next.click();
            }
          }
        }
        const seat = visible('#step-seat-departure');
        // D-Ticket reuses this seat page and rebuilds its inputs for the return leg.
        const seatStep = typeof step === 'undefined' ? '40' : String(step);
        const assignments = profiles.map((_, index) =>
          document.querySelector('input[name="data-seat-user-' + (index + 1) + '"]'),
        );
        const readyReturn =
          seatStep === '41' &&
          target.returnLeg &&
          advancedSeats.has('40') &&
          assignments.every((assigned, index) => assigned !== departureAssignments[index]);
        if (
          !gender &&
          seat &&
          (seatStep === '40' || readyReturn) &&
          !advancedSeats.has(seatStep) &&
          assignments.every((assigned) => assigned?.value) &&
          typeof handleNextButtonClicked === 'function'
        ) {
          for (const [index, profile] of profiles.entries()) {
            if (profile.mode === 'custom') booking.personal[index] = { ...profile };
          }
          if (target.preferLowerBerths !== false) {
            for (const [index, assigned] of assignments.entries())
              this.preferLowerBerth(seat, assigned, index + 1);
          }
          if (assignments.some((assigned) => !assigned.value)) {
            stop();
            return;
          }
          const next = seat.querySelector('[onclick="handleNextButtonClicked()"]');
          if (next && !next.disabled && !next.classList.contains('disabled')) {
            advancedSeats.add(seatStep);
            if (seatStep === '40') departureAssignments = assignments;
            next.click();
          }
        }
      }
      setTimeout(tick, 250);
    };
    tick();
  },
};
