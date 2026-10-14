(function (scope) {
  function days(year, month) {
    const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Array.from({ length: count }, (_, i) =>
      new Date(Date.UTC(year, month, i + 1)).toISOString().slice(0, 10),
    );
  }
  function bind({ $, updateDateBounds, onChange, watch }) {
    const dialog = $('dateCalendar');
    let input,
      trigger,
      year,
      month,
      multiple = false,
      dayFocus = null;
    function position() {
      const rect = trigger.getBoundingClientRect();
      dialog.style.left =
        Math.max(12, Math.min(rect.left, innerWidth - dialog.offsetWidth - 12)) + 'px';
      dialog.style.top =
        Math.max(12, Math.min(rect.bottom + 8, innerHeight - dialog.offsetHeight - 12)) + 'px';
    }
    function refreshWatch() {
      if (!multiple || !dialog.open) return;
      const state = watch.getDates();
      const focused = dialog.querySelector(':focus');
      if (focused?.dataset.day) dayFocus = focused.dataset.day;
      else if (focused) dayFocus = null;
      for (const button of $('calendarDays').querySelectorAll('[data-day]')) {
        button.disabled = state.disabled || !state.available.includes(button.dataset.day);
        button.setAttribute('aria-pressed', state.selected.includes(button.dataset.day));
      }
      $('calendarSelection').textContent =
        `${state.selected.length} ${state.selected.length === 1 ? 'date' : 'dates'} selected`;
      $('calendarPrev').disabled =
        state.disabled || days(year, month - 1).at(-1) < state.available[0];
      $('calendarNext').disabled =
        state.disabled || days(year, month + 1)[0] > state.available.at(-1);
      if (!state.disabled && dayFocus) {
        dialog.querySelector(`[data-day="${dayFocus}"]:not(:disabled)`)?.focus();
        dayFocus = null;
      }
    }
    function render() {
      const state = multiple ? watch.getDates() : null;
      $('calendarMonth').textContent = new Date(Date.UTC(year, month, 1)).toLocaleDateString(
        'en-GB',
        { month: 'long', year: 'numeric', timeZone: 'UTC' },
      );
      const offset = new Date(Date.UTC(year, month, 1)).getUTCDay();
      $('calendarDays').innerHTML =
        ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => '<span>' + d + '</span>').join('') +
        '<span></span>'.repeat(offset) +
        days(year, month)
          .map((date) => {
            const selected = multiple ? state.selected.includes(date) : date === input.value;
            const disabled = multiple
              ? state.disabled || !state.available.includes(date)
              : date < input.min;
            const label = multiple
              ? `Watch departure ${Number(date.slice(-2))}/${date.slice(5, 7)}/${date.slice(0, 4)}`
              : date;
            return `<button type="button" data-day="${date}" aria-label="${label}" aria-pressed="${selected}" ${disabled ? 'disabled' : ''} ${!multiple && date === input.min ? 'data-today' : ''}>${Number(date.slice(-2))}</button>`;
          })
          .join('');
      if (multiple) refreshWatch();
      else {
        $('calendarPrev').disabled = days(year, month - 1).at(-1) < input.min;
        $('calendarNext').disabled = false;
      }
      if (dialog.open) position();
    }
    function open(value) {
      [year, month] = value.split('-').map(Number);
      month--;
      if (watch) {
        dialog.classList.toggle('watch-date-calendar', multiple);
        $('calendarFooter').hidden = !multiple;
      }
      render();
      dialog.showModal();
      refreshWatch();
      trigger.setAttribute('aria-expanded', 'true');
      position();
      const selected = dialog.querySelector?.('[aria-pressed="true"]:not(:disabled)');
      (selected || $('calendarClose')).focus?.();
    }
    for (const id of ['from', 'through'])
      $(id + 'Calendar').onclick = () => {
        if ($(id).disabled) return;
        updateDateBounds();
        multiple = false;
        dayFocus = null;
        input = $(id);
        trigger = $(id + 'Calendar');
        open(input.value || input.min);
      };
    if (watch) {
      $('watchDatesCalendar').onclick = () => {
        const state = watch.getDates();
        if (state.disabled || !state.available.length) return;
        multiple = true;
        dayFocus = null;
        trigger = $('watchDatesCalendar');
        open(state.selected[0] || state.available[0]);
      };
      $('calendarDone').onclick = () => dialog.close();
      $('calendarDays').onkeydown = (event) => {
        if (!multiple) return;
        const button = event.target.closest('[data-day]');
        const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (!button || button.disabled || !(event.key in offsets)) return;
        event.preventDefault();
        const date = new Date(button.dataset.day + 'T00:00:00Z');
        date.setUTCDate(date.getUTCDate() + offsets[event.key]);
        const next = date.toISOString().slice(0, 10);
        if (!watch.getDates().available.includes(next)) return;
        if (date.getUTCMonth() !== month || date.getUTCFullYear() !== year) {
          year = date.getUTCFullYear();
          month = date.getUTCMonth();
          render();
        }
        dialog.querySelector(`[data-day="${next}"]:not(:disabled)`)?.focus();
      };
    }
    $('calendarPrev').onclick = () => {
      if (month === 0) {
        year--;
        month = 11;
      } else month--;
      render();
    };
    $('calendarNext').onclick = () => {
      if (month === 11) {
        year++;
        month = 0;
      } else month++;
      render();
    };
    $('calendarClose').onclick = () => dialog.close();
    $('calendarDays').onclick = (event) => {
      const button = event.target.closest('[data-day]');
      if (!button || button.disabled) return;
      if (multiple) {
        const state = watch.getDates();
        if (state.disabled || !state.available.includes(button.dataset.day)) return;
        watch.onChange(button.dataset.day);
        refreshWatch();
        return;
      }
      updateDateBounds();
      if (button.dataset.day < input.min) {
        render();
        return;
      }
      input.value = button.dataset.day;
      dialog.close();
      onChange(input.id);
    };
    dialog.onclose = () => {
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    };
    dialog.onclick = (event) => {
      if (event.target === dialog) {
        const r = dialog.getBoundingClientRect();
        if (
          event.clientX < r.left ||
          event.clientX > r.right ||
          event.clientY < r.top ||
          event.clientY > r.bottom
        )
          dialog.close();
      }
    };
    return { refreshWatch };
  }
  scope.RailWatchCalendar = { days, bind };
  if (typeof module !== 'undefined') module.exports = scope.RailWatchCalendar;
})(globalThis);
