globalThis.RailWatchRenderers = ({ root, $, escape, dates, key, match, state }) => {
  const parseDMY = (value) => {
    const [day, month, year] = value.split('/').map(Number);
    return new Date(year, month - 1, day);
  };
  const thDay = (date) => new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(date);
  const thShort = (date) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(date);
  const seatTotal = (row) => row.coaches.filter(match).reduce((sum, coach) => sum + coach.count, 0);
  let matrixMarkup, matrixColumns, detailMarkup, detailKey;
  let uncheckedNotice = false;
  function updateAvailabilityNotice() {
    const notice = $('availabilityNotice');
    if (!notice || notice.hidden) return;
    notice.textContent =
      (uncheckedNotice ? 'No seats found in the checked dates. ' : 'No seats available yet. ') +
      state.availabilityStatus(uncheckedNotice);
  }
  function setDetail(markup, key = null) {
    if (markup === detailMarkup && key === detailKey) return;
    const detail = $('detail');
    const list = key && key === detailKey && detail.querySelector('.dt-coaches');
    if (list) {
      const focusedCoach =
        root.activeElement?.closest('.dt-coaches') === list
          ? root.activeElement.dataset.bookCoach
          : null;
      const template = document.createElement('template');
      template.innerHTML = markup;
      const nextList = template.content.querySelector('.dt-coaches');
      const existing = new Map([...list.children].map((row) => [row.dataset.coachId, row]));
      const rows = [...nextList.children].map((next) => {
        const current = existing.get(next.dataset.coachId);
        if (!current) return next;
        if (!current.isEqualNode(next)) {
          current.className = next.className;
          current.innerHTML = next.innerHTML;
        }
        return current;
      });
      rows.forEach((row, index) => {
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      });
      for (const row of [...list.children]) if (!rows.includes(row)) row.remove();
      const header = detail.querySelector('.dt-head');
      const nextHeader = template.content.querySelector('.dt-head');
      if (!header.isEqualNode(nextHeader)) header.replaceWith(nextHeader);
      if (focusedCoach) {
        const button = rows
          .find((row) => row.dataset.coachId === focusedCoach)
          ?.querySelector('button[data-book-coach]');
        if (button && !button.disabled) button.focus();
      }
    } else detail.innerHTML = markup;
    detailMarkup = markup;
    detailKey = key;
  }

  function setMatrix(markup, columns = null) {
    const signature = markup.replace(/ aria-pressed="(?:true|false)"/g, '');
    if (signature === matrixMarkup) return;
    const matrix = $('matrix');
    const table = matrix.querySelector?.('.mx-t');
    if (table && columns !== null && columns === matrixColumns) {
      const template = document.createElement('template');
      template.innerHTML = markup;
      const nextTable = template.content.querySelector('.mx-t');
      const existing = new Map(
        [...table.querySelectorAll('tbody > tr, tfoot > tr')].map((row) => [
          row.dataset.rowDate,
          row,
        ]),
      );
      for (const name of ['tbody', 'tfoot']) {
        const next = nextTable.querySelector(name);
        let section = table.querySelector(name);
        if (!next) {
          section?.remove();
          continue;
        }
        if (!section) {
          section = document.createElement(name);
          section.className = next.className;
          table.append(section);
        }
        const rows = [...next.children].map((candidate) => {
          const previous = existing.get(candidate.dataset.rowDate);
          return previous?.outerHTML === candidate.outerHTML ? previous : candidate;
        });
        for (const [index, row] of rows.entries()) {
          if (section.children[index] !== row)
            section.insertBefore(row, section.children[index] || null);
        }
        for (const row of [...section.children]) if (!rows.includes(row)) row.remove();
      }
    } else {
      matrix.innerHTML = markup;
    }
    matrixMarkup = signature;
    matrixColumns = columns;
  }
  function emptyDetail() {
    setDetail(
      '<div class="dt-in"><header class="dt-head"><h3>Select a train</h3></header><div class="dt-notchecked"><p class="note">Choose a cell to see the coaches, seat counts and booking options.</p></div></div>',
    );
  }
  function render() {
    const notice = $('availabilityNotice');
    if (notice) {
      notice.hidden = true;
      notice.textContent = '';
    }
    let days;
    try {
      days = dates();
    } catch (error) {
      setMatrix(
        '<div class="empty card matrix-empty"><span class="eyebrow">Check your route and dates</span><p class="empty-body">' +
          escape(error.message) +
          '</p></div>',
      );
      emptyDetail();
      return;
    }
    const data = [
      ...new Map(
        [...(state.cachedData || []), ...(state.data || [])].map((row) => [
          row.date + '|' + row.train,
          row,
        ]),
      ).values(),
    ];
    const trains = [
      ...new Map(
        data.map((row) => [row.train, { no: row.train, dep: row.departure, arr: row.arrival }]),
      ).values(),
    ].sort(
      (a, b) =>
        a.dep.localeCompare(b.dep) || a.no.localeCompare(b.no, undefined, { numeric: true }),
    );
    if (!trains.length) {
      if (state.loadingStatus?.()) {
        setMatrix(
          '<div class="empty card matrix-empty" role="status"><span class="eyebrow">Checking availability</span><p class="empty-body">Results will appear when this check finishes.</p></div>',
        );
        emptyDetail();
        return;
      }
      setMatrix(
        '<div class="empty card matrix-empty"><span class="eyebrow">No data for these dates</span><p class="empty-body">Run a check to see train availability for the selected route and dates.</p><button class="pill pill-sm" data-recheck-empty>Check now</button></div>',
      );
      emptyDetail();
      return;
    }
    const rowsByKey = new Map(data.map((row) => [row.date + '|' + row.train, row]));
    const head =
      '<tr><th scope="col" class="mx-date">Date</th>' +
      trains
        .map(
          (train) =>
            '<th scope="col"><span class="th-no">Train ' +
            escape(train.no) +
            '</span><span class="th-time mono">' +
            escape(train.dep) +
            ' → ' +
            escape(train.arr) +
            '</span></th>',
        )
        .join('') +
      '</tr>';
    let anyData = false,
      allZero = true,
      anyUnchecked = false;
    const body = days
      .map((day) => {
        const date = key(day),
          dt = parseDMY(date);
        const cells = trains
          .map((train) => {
            const row = rowsByKey.get(date + '|' + train.no);
            if (row) {
              anyData = true;
              if (seatTotal(row) > 0) allZero = false;
            } else anyUnchecked = true;
            return '<td>' + cellBtn(date, dt, row, train.no) + '</td>';
          })
          .join('');
        return (
          '<tr data-row-date="' +
          date +
          '"><th scope="row" class="mx-date">' +
          thDay(dt) +
          ' ' +
          thShort(dt) +
          '</th>' +
          cells +
          '</tr>'
        );
      })
      .join('');
    if (notice && anyData && allZero) {
      notice.hidden = false;
      uncheckedNotice = anyUnchecked;
      updateAvailabilityNotice();
    }
    setMatrix(
      '<div class="mx"><div class="mx-scroll"><table class="mx-t"><thead>' +
        head +
        '</thead><tbody>' +
        body +
        '</tbody></table></div>' +
        legendHTML() +
        '</div>',
      head,
    );
    if (state.selected && days.some((day) => key(day) === state.selected[0]))
      showDetail(...state.selected);
    else {
      state.selected = null;
      root
        .querySelectorAll('.mx-cell[aria-pressed="true"]')
        .forEach((cell) => cell.setAttribute('aria-pressed', 'false'));
      emptyDetail();
    }
    fitMatrix();
  }
  function cellBtn(date, dt, row, train) {
    const loading = !row && state.loadingStatus?.(date);
    if (loading)
      return (
        '<button class="mx-cell st-loading" disabled aria-label="' +
        thShort(dt) +
        ' train ' +
        escape(train) +
        ' ' +
        loading +
        '"><b>–</b><i>' +
        (loading === 'checking' ? 'Checking' : 'Waiting') +
        '</i></button>'
      );
    if (!row)
      return (
        '<button class="mx-cell st-na" data-action="cell" data-date="' +
        date +
        '" data-train="' +
        escape(train) +
        '" aria-label="' +
        thShort(dt) +
        ' train ' +
        escape(train) +
        ' not checked"><b>–</b><i>Not checked</i></button>'
      );
    const count = seatTotal(row);
    const cls =
      count > 5
        ? 'st-ok' + (count >= 100 ? ' hi' : count >= 25 ? ' md' : '')
        : count > 0
          ? 'st-low'
          : 'st-out';
    const selected = state.selected && state.selected[0] === date && state.selected[1] === train;
    return (
      '<button class="mx-cell ' +
      cls +
      '" data-action="cell" data-date="' +
      date +
      '" data-train="' +
      escape(train) +
      '" aria-pressed="' +
      Boolean(selected) +
      '" aria-label="' +
      thShort(dt) +
      ' train ' +
      escape(train) +
      ' ' +
      (count > 0 ? count + ' seats available' : 'fully booked') +
      '"><b>' +
      count +
      '</b><i>' +
      (count === 0 ? 'Sold out' : count <= 5 ? 'Low' : 'Available') +
      '</i></button>'
    );
  }
  function legendHTML() {
    return '<p class="mx-legend"><i class="dot st-txt-ok">●</i> Available &gt;5 · <i class="dot st-txt-low">●</i> Low 1–5</p>';
  }
  function showDetail(date, train) {
    state.selected = [date, train];
    root
      .querySelectorAll('.mx-cell[aria-pressed="true"]')
      .forEach((cell) => cell.setAttribute('aria-pressed', 'false'));
    root
      .querySelectorAll('.mx-cell[data-date="' + date + '"][data-train="' + train + '"]')
      .forEach((cell) => cell.setAttribute('aria-pressed', 'true'));
    const row = state.data.find((item) => item.date === date && item.train === train);
    const dt = parseDMY(date);
    const header =
      '<header class="dt-head"><h3>Train ' +
      escape(train) +
      ' · ' +
      thDay(dt) +
      ' ' +
      thShort(dt) +
      '</h3>' +
      (row
        ? '<p class="dt-meta mono">' +
          escape(row.departure) +
          ' → ' +
          escape(row.arrival) +
          ' <em>(+1 day)</em></p>'
        : '') +
      '</header>';
    if (!row) {
      const loading = state.loadingStatus?.(date);
      if (loading) {
        setDetail(
          '<div class="dt-in">' +
            header +
            '<div class="dt-notchecked" role="status"><p class="note">' +
            (loading === 'checking'
              ? 'Checking this date…'
              : 'This date is waiting for the current check.') +
            '</p></div></div>',
        );
        return;
      }
      setDetail(
        '<div class="dt-in">' +
          header +
          '<div class="dt-notchecked"><p class="note">No seat data for this date and train yet.</p><button class="pill pill-sm" data-recheck-empty>Check now</button></div></div>',
      );
      return;
    }
    const coaches = [...row.coaches]
      .sort(
        (a, b) =>
          Number(b.count > 0) - Number(a.count > 0) ||
          a.count - b.count ||
          Number(a.class) - Number(b.class) ||
          Number(b.air === 'Air Coach') - Number(a.air === 'Air Coach'),
      )
      .map((coach) => {
        const available = coach.count > 0;
        const cls = coach.count > 5 ? 'st-txt-ok' : available ? 'st-txt-low' : '';
        const status = coach.count > 5 ? 'Available' : available ? 'Low' : 'Sold out';
        const tone = coach.count > 5 ? 'avail' : available ? 'lowst' : 'sold-out';
        const label =
          'Class ' +
          coach.class +
          ' · ' +
          (coach.type === 'Sleeping Coach' ? 'Sleeper' : 'Seat') +
          ' · ' +
          (coach.air === 'Air Coach' ? 'A/C' : 'Fan');
        const thai =
          coach.desc ||
          'ชั้น ' +
            coach.class +
            ' · ' +
            (coach.type === 'Sleeping Coach' ? 'รถนอน' : 'รถนั่ง') +
            ' · ' +
            (coach.air === 'Air Coach' ? 'ปรับอากาศ' : 'พัดลม');
        const prices = coach.prices
          .map(
            (price) =>
              '<span class="pr">' +
              escape(price.type || 'Seat') +
              ' ฿' +
              Number(price.price).toLocaleString('en-US') +
              '</span>',
          )
          .join('');
        const inner =
          '<span class="ty">' +
          escape(label) +
          (available ? ' <i class="go">↗</i>' : '') +
          '</span><span class="coach-desc" lang="th">' +
          escape(thai).replaceAll(' - ', '<br>') +
          '</span><span class="cnt mono ' +
          cls +
          '">' +
          coach.count +
          '</span><span class="state mono ' +
          cls +
          '">' +
          status +
          '</span><span class="prs">' +
          prices +
          '</span>';
        const attrs =
          'data-book-train="' +
          escape(train) +
          '" data-book-date="' +
          escape(date) +
          '" data-book-coach="' +
          escape(coach.id || '') +
          '" data-book-class="' +
          escape(coach.class) +
          '" data-book-type="' +
          escape(coach.type) +
          '" data-book-air="' +
          escape(coach.air) +
          '"';
        return (
          '<li data-coach-id="' +
          escape(coach.id) +
          '" class="' +
          tone +
          '">' +
          (available
            ? '<button class="row-link" ' +
              attrs +
              ' aria-label="Book Cl.' +
              escape(coach.class) +
              ' on D-Ticket">' +
              inner +
              '</button>'
            : '<div class="row-link">' + inner + '</div>') +
          '</li>'
        );
      })
      .join('');
    setDetail(
      '<div class="dt-in">' + header + '<ul class="dt-coaches">' + coaches + '</ul></div>',
      date + '|' + train,
    );
  }
  function fitMatrix() {
    const scroll = root.querySelector('.ck-matrix .mx-scroll');
    const table = scroll?.querySelector('.mx-t');
    if (!scroll || !table) return;
    const rows = table.querySelectorAll('tbody tr, tfoot tr').length;
    if (!rows) return;
    const header = table.querySelector('thead');
    const available = Math.max(
      150,
      scroll.clientHeight - (header ? header.getBoundingClientRect().height : 0) - 8,
    );
    const height = Math.max(42, Math.min(132, Math.floor(available / rows) - 8));
    table.style.setProperty('--row-h', height + 'px');
    table.classList.toggle('dense', height < 56);
  }

  return { render, showDetail, fitMatrix, updateAvailabilityNotice };
};
