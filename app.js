(function () {
  "use strict";

  // Bump on every update (also bump CACHE_VERSION in sw.js and ?v= in index.html).
  var APP_VERSION = "1.1.0";

  var STORAGE_KEY = "gospelPartners.v1";
  var SETTINGS_KEY = "gospelPartners.settings.v1";
  var DAY_MS = 24 * 60 * 60 * 1000;
  var DEFAULT_MONTH_RANGE = 3;
  var GRIP_ICON =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="5" cy="3" r="1.3" fill="currentColor"/><circle cx="11" cy="3" r="1.3" fill="currentColor"/>' +
    '<circle cx="5" cy="8" r="1.3" fill="currentColor"/><circle cx="11" cy="8" r="1.3" fill="currentColor"/>' +
    '<circle cx="5" cy="13" r="1.3" fill="currentColor"/><circle cx="11" cy="13" r="1.3" fill="currentColor"/>' +
    "</svg>";

  /** @type {Array<Object>} */
  var partners = [];
  var settings = {
    monthRange: DEFAULT_MONTH_RANGE,
    lastShuffleMonthIndex: null,
    theme: "light",
    cycleEndDate: null,
    deferredUntilNewMonth: false,
    deferredMonthRange: null,
    lastPromptedForEndDate: null,
    badgeEnabled: false
  };
  var pendingGivingTargetId = null; // id awaiting an amount from the giving modal
  var pendingGivingIsNewPartner = false;
  var pendingDateStartedId = null;
  var givingSort = { column: "date", dir: "asc" };

  // ---------- persistence ----------
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      partners = raw ? JSON.parse(raw) : [];
    } catch (e) {
      partners = [];
    }
    try {
      var rawSettings = localStorage.getItem(SETTINGS_KEY);
      if (rawSettings) {
        var parsed = JSON.parse(rawSettings);
        if (parsed && [1, 2, 3].indexOf(parsed.monthRange) !== -1) {
          settings.monthRange = parsed.monthRange;
        }
        if (parsed && typeof parsed.lastShuffleMonthIndex === "number") {
          settings.lastShuffleMonthIndex = parsed.lastShuffleMonthIndex;
        }
        if (parsed && typeof parsed.badgeEnabled === "boolean") {
          settings.badgeEnabled = parsed.badgeEnabled;
        }
        if (parsed && (parsed.theme === "light" || parsed.theme === "dark")) {
          settings.theme = parsed.theme;
        }
        if (parsed && typeof parsed.cycleEndDate === "string") {
          settings.cycleEndDate = parsed.cycleEndDate;
        }
        if (parsed && typeof parsed.deferredUntilNewMonth === "boolean") {
          settings.deferredUntilNewMonth = parsed.deferredUntilNewMonth;
        }
        if (parsed && [1, 2, 3].indexOf(parsed.deferredMonthRange) !== -1) {
          settings.deferredMonthRange = parsed.deferredMonthRange;
        }
        if (parsed && typeof parsed.lastPromptedForEndDate === "string") {
          settings.lastPromptedForEndDate = parsed.lastPromptedForEndDate;
        }
      }
    } catch (e) {
      // keep default
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(partners));
    } catch (e) {
      // storage unavailable; app still works for the session
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      // storage unavailable; app still works for the session
    }
  }

  // ---------- date helpers ----------
  function todayAtMidnight() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function toISODate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function parseISODate(s) {
    if (!s) return null;
    var parts = s.split("-");
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }

  function formatDisplayDate(s) {
    var d = parseISODate(s);
    if (!d) return "—";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  // Compact form used in the table so every column fits without a horizontal
  // scrollbar on narrow screens - the exact day is still available by tapping
  // through to the date-started popup or the giving edit modal.
  function formatMonthYear(s) {
    var d = parseISODate(s);
    if (!d) return "";
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  function formatMonthDay(s) {
    var d = parseISODate(s);
    if (!d) return "—";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatMoney(n) {
    var num = Number(n) || 0;
    return "$" + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Adds n months to a date while preserving the day-of-month where possible
  // (e.g. Jan 31 + 1 month lands on Feb 28, not rolling over into March).
  function addMonthsPreserveDay(date, n) {
    var day = date.getDate();
    var d = new Date(date.getTime());
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    var daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, daysInMonth));
    return d;
  }

  function monthIndex(d) {
    return d.getFullYear() * 12 + d.getMonth();
  }

  // A giving date keeps showing the same day all month long (even after that day
  // has passed) and only rolls forward once the calendar reaches a new month -
  // i.e. on/after the 1st of the following month, it jumps to the same day next month.
  function rollGivingDatesForward() {
    var today = todayAtMidnight();
    var todayIdx = monthIndex(today);
    var changed = false;
    partners.forEach(function (p) {
      if (!p.giving || !p.givingDate) return;
      var d = parseISODate(p.givingDate);
      if (!d) return;
      var guard = 0;
      while (monthIndex(d) < todayIdx && guard < 1200) {
        d = addMonthsPreserveDay(d, 1);
        changed = true;
        guard++;
      }
      p.givingDate = toISODate(d);
    });
    return changed;
  }

  // Whether a giving date falls on or before today - i.e. this month's gift is due/given.
  function isGivingDatePast(givingDate) {
    var d = parseISODate(givingDate);
    if (!d) return false;
    var today = todayAtMidnight();
    return d.getTime() <= today.getTime();
  }

  function durationMessage(partner) {
    var start = parseISODate(partner.dateStarted);
    if (!start) return "";
    var today = todayAtMidnight();
    var years = today.getFullYear() - start.getFullYear();
    var months = today.getMonth() - start.getMonth();
    if (today.getDate() < start.getDate()) months--;
    if (months < 0) { years--; months += 12; }
    if (years < 0) { years = 0; months = 0; }

    var parts = [];
    if (years > 0) parts.push(years + (years === 1 ? " year" : " years"));
    if (months > 0) parts.push(months + (months === 1 ? " month" : " months"));
    var durationStr = parts.length ? parts.join(" and ") : "less than a month";

    return "You've been partnering with " + partner.name + " for " + durationStr + "!";
  }

  // ---------- scheduling ----------
  // The end of the selected month range: e.g. a range of 2 starting in September
  // ends on October 31 (the last day of the second month in the range).
  function endOfMonthRange(monthRange, fromDate) {
    var y = fromDate.getFullYear();
    var m = fromDate.getMonth();
    return new Date(y, m + monthRange, 0);
  }

  
  // Evenly distribute every partner's next prayer date across the configured
  // month-range window, starting from the 1st of the current month through the
  // end of the range's final month. This only ever runs when a new prayer
  // cycle is explicitly started - dates otherwise stay fixed once assigned.
  function recomputeSchedule() {
    var n = partners.length;
    if (n === 0) return;
    var today = todayAtMidnight();
    var windowStart = new Date(today.getFullYear(), today.getMonth(), 1);
    var windowEnd = endOfMonthRange(settings.monthRange, today);
    var windowDays = Math.max(1, Math.round((windowEnd.getTime() - windowStart.getTime()) / DAY_MS));

    // Slots are handed out by list position: prayed partners (top of the list)
    // hold the earliest slots, unprayed partners the later ones.
    partners.forEach(function (p, i) {
      var offsetDays = Math.round(((i + 0.5) * windowDays) / n);
      offsetDays = Math.max(0, Math.min(windowDays, offsetDays));
      var d = new Date(windowStart.getTime() + offsetDays * DAY_MS);
      p.scheduled = toISODate(d);
    });
  }

  // A partner that doesn't have a scheduled date yet (brand new, or legacy data
  // from before this feature) gets parked at the end of the current cycle
  // window without disturbing anyone else's already-assigned date. It'll fall
  // into its proper evenly-spaced slot the next time a new cycle starts.
  function assignFallbackDate(p) {
    var today = todayAtMidnight();
    var end = endOfMonthRange(settings.monthRange, today);
    p.scheduled = toISODate(end);
  }

  // Starts a new prayer cycle: clears every "prayed" mark and redistributes every
  // partner's scheduled date evenly from the start of this month through the
  // end of the selected month range.
  function startNewCycle(monthRange) {
    settings.monthRange = monthRange;
    settings.cycleEndDate = toISODate(endOfMonthRange(monthRange, todayAtMidnight()));
    settings.deferredUntilNewMonth = false;
    settings.deferredMonthRange = null;
    settings.lastPromptedForEndDate = null;
    saveSettings();
    partners.forEach(function (p) { p.prayed = false; });
    recomputeSchedule();
    save();
    render();
  }

  // Fisher-Yates shuffle, in place.
  function shuffleArray(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  // Once per calendar month, shuffle the partner order so the rotation doesn't
  // always land the same way. Scheduled dates are untouched - they only change
  // when a new cycle is explicitly started - but the new order determines how
  // the next cycle's dates get distributed.
  function shuffleForNewMonthIfNeeded() {
    var todayIdx = monthIndex(todayAtMidnight());
    if (settings.lastShuffleMonthIndex === todayIdx) return false;
    if (partners.length > 1) shuffleArray(partners);
    settings.lastShuffleMonthIndex = todayIdx;
    saveSettings();
    return true;
  }

  // Checks whether the current prayer cycle has run past its end date. If so,
  // and the person hasn't already answered for this particular cycle-end
  // (or is already waiting on a deferred start), surfaces the cycle-end modal
  // asking them to start a new one now or wait for next month.
  // Returns true if the modal should be shown.
  function isCycleEndPromptDue() {
    var today = todayAtMidnight();

    if (!settings.cycleEndDate) {
      // First run / upgrading from before this feature existed - just adopt
      // the current month range silently, nothing to prompt about yet.
      settings.cycleEndDate = toISODate(endOfMonthRange(settings.monthRange, today));
      saveSettings();
      return false;
    }

    var endDate = parseISODate(settings.cycleEndDate);

    if (settings.deferredUntilNewMonth) {
      if (monthIndex(today) > monthIndex(endDate)) {
        startNewCycle(settings.deferredMonthRange || settings.monthRange);
      }
      return false;
    }

    if (today.getTime() > endDate.getTime()) {
      return settings.lastPromptedForEndDate !== settings.cycleEndDate;
    }
    return false;
  }

  function scheduleColorClass(partner) {
    if (partner.prayed) return "date-normal";
    var sched = parseISODate(partner.scheduled);
    if (!sched) return "date-normal";
    var today = todayAtMidnight();
    var diffDays = Math.round((sched.getTime() - today.getTime()) / DAY_MS);
    if (diffDays < 0) return "date-past";
    if (diffDays <= 3) return "date-soon";
    return "date-normal";
  }

  // ---------- rendering ----------
  function render() {
    renderPartnersTable();
    renderGivingTable();
    renderNextUp();
    renderProgress();
    updateAppBadge();
  }

  var swipeAnimating = false;

  function renderNextUp() {
    var wrap = document.getElementById("next-up-wrap");
    var card = document.getElementById("next-up-card");
    var unprayed = partners.filter(function (p) { return !p.prayed && p.scheduled; });
    if (unprayed.length === 0) {
      wrap.style.display = "none";
      return;
    }
    var next = unprayed.reduce(function (soonest, p) {
      return parseISODate(p.scheduled).getTime() < parseISODate(soonest.scheduled).getTime() ? p : soonest;
    });
    document.getElementById("next-up-name").textContent = next.name;
    document.getElementById("next-up-ministry").textContent = next.ministry;
    document.getElementById("next-up-date").textContent = formatMonthDay(next.scheduled);
    card.dataset.partnerId = next.id;
    wrap.style.display = "block";

    // Only snap the card back to a neutral resting position when we're not in
    // the middle of our own swipe fly-off/fade-in animation sequence (which
    // manages these same styles itself, step by step).
    if (!swipeAnimating) {
      card.classList.remove("snap-transition", "dragging");
      wrap.classList.remove("revealed");
      card.style.transition = "none";
      card.style.transform = "translateX(0) rotate(0deg)";
      card.style.opacity = "1";
      document.getElementById("overlay-prayed").style.opacity = 0;
      document.getElementById("overlay-skip").style.opacity = 0;
      void card.offsetWidth;
      card.style.transition = "";
    }
  }

  function renderProgress() {
    var card = document.getElementById("progress-card");
    var todayIdx = monthIndex(todayAtMidnight());
    var total = 0;
    var prayedCount = 0;
    partners.forEach(function (p) {
      var d = parseISODate(p.scheduled);
      if (d && monthIndex(d) === todayIdx) {
        total++;
        if (p.prayed) prayedCount++;
      }
    });
    if (total === 0) {
      card.style.display = "none";
      return;
    }
    card.style.display = "block";
    document.getElementById("progress-count").textContent = prayedCount + " of " + total;
    var pct = Math.round((prayedCount / total) * 100);
    document.getElementById("progress-fill").style.width = pct + "%";
  }

  function renderPartnersTable() {
    var tbody = document.getElementById("partners-tbody");
    var emptyEl = document.getElementById("partners-empty");
    var wrapEl = document.getElementById("partners-table-wrap");
    tbody.innerHTML = "";

    if (partners.length === 0) {
      wrapEl.style.display = "none";
      emptyEl.style.display = "block";
      return;
    }
    wrapEl.style.display = "block";
    emptyEl.style.display = "none";

    partners.forEach(function (p) {
      var tr = document.createElement("tr");
      tr.dataset.id = p.id;
      if (p.prayed) tr.classList.add("prayed");

      var dateClass = scheduleColorClass(p);
      var startedDisplay = p.dateStarted
        ? '<span class="date-started-tag" data-action="edit-date-started">Since ' + formatMonthYear(p.dateStarted) + "</span>"
        : '<span class="date-started-tag hint-add-date" data-action="edit-date-started">+ Add date</span>';

      tr.innerHTML =
        '<td class="handle-col"><span class="drag-handle" data-role="drag-handle" aria-label="Drag to reorder ' + escapeHtml(p.name) + '">' + GRIP_ICON + "</span></td>" +
        '<td class="name-cell" data-label="Name">' +
          "<strong>" + escapeHtml(p.name) + "</strong>" +
          '<span class="ministry-line">' + escapeHtml(p.ministry) + "</span>" +
          startedDisplay +
        "</td>" +
        '<td class="center" data-label="Giving"><input type="checkbox" class="checkbox giving-checkbox" data-action="toggle-giving" ' + (p.giving ? "checked" : "") + "></td>" +
        '<td class="' + dateClass + '" data-label="Sched.">' + formatMonthDay(p.scheduled) + "</td>" +
        '<td class="center" data-label="Prayed"><input type="checkbox" class="checkbox" data-action="toggle-prayed" ' + (p.prayed ? "checked" : "") + "></td>" +
        '<td class="center remove-cell" data-label=""><button type="button" class="row-remove" data-action="remove" title="Remove partner" aria-label="Remove ' + escapeHtml(p.name) + '">&times;</button></td>';

      tbody.appendChild(tr);
    });
  }

  function renderGivingTable() {
    var tbody = document.getElementById("giving-tbody");
    var emptyEl = document.getElementById("giving-empty");
    var givers = partners.filter(function (p) { return p.giving; });

    if (givingSort.column === "amount") {
      givers.sort(function (a, b) {
        var diff = (Number(a.givingAmount) || 0) - (Number(b.givingAmount) || 0);
        return givingSort.dir === "asc" ? diff : -diff;
      });
    } else if (givingSort.column === "date") {
      givers.sort(function (a, b) {
        var da = parseISODate(a.givingDate);
        var db = parseISODate(b.givingDate);
        var diff = (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
        return givingSort.dir === "asc" ? diff : -diff;
      });
    }

    tbody.innerHTML = "";

    if (givers.length === 0) {
      emptyEl.style.display = "block";
    } else {
      emptyEl.style.display = "none";
    }

    var total = 0;
    givers.forEach(function (p) {
      total += Number(p.givingAmount) || 0;
      var tr = document.createElement("tr");
      tr.dataset.id = p.id;
      var dateChipClass = "date-chip" + (isGivingDatePast(p.givingDate) ? " date-chip-past" : "");
      tr.innerHTML =
        '<td class="name-cell" data-label="Name"><strong>' + escapeHtml(p.name) + "</strong></td>" +
        '<td class="amount-cell editable" data-label="Amount" data-action="edit-giving">' + formatMoney(p.givingAmount) + "</td>" +
        '<td class="editable" data-label="Date" data-action="edit-giving"><span class="' + dateChipClass + '">' + formatDisplayDate(p.givingDate) + "</span></td>";
      tbody.appendChild(tr);
    });

    document.getElementById("giving-total").textContent = formatMoney(total);
    document.getElementById("giving-count").textContent = String(givers.length);

    document.querySelectorAll(".sort-arrow").forEach(function (el) {
      var col = el.dataset.arrow;
      if (givingSort.column === col) {
        el.textContent = givingSort.dir === "asc" ? "▲" : "▼";
      } else {
        el.textContent = "";
      }
    });
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // ---------- modals ----------
  function openModal(id) {
    document.getElementById(id).classList.add("active");
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove("active");
  }

  function openGivingModal(partner, isNew) {
    pendingGivingTargetId = partner.id;
    pendingGivingIsNewPartner = !!isNew;
    document.getElementById("giving-modal-title").textContent = "Record giving for " + partner.name;
    document.getElementById("g-amount").value = partner.givingAmount || "";
    var existingDay = partner.givingDate ? parseISODate(partner.givingDate).getDate() : todayAtMidnight().getDate();
    document.getElementById("g-date-day").value = existingDay;
    openModal("giving-modal");
    setTimeout(function () { document.getElementById("g-amount").focus(); }, 50);
  }

  // Builds an ISO date string for the given day-of-month, in the current
  // month/year - clamped to the number of days the current month actually has.
  function dateForDayInCurrentMonth(day) {
    var today = todayAtMidnight();
    var daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    var clamped = Math.min(Math.max(1, day), daysInMonth);
    return toISODate(new Date(today.getFullYear(), today.getMonth(), clamped));
  }

  function openDateStartedModal(partner) {
    pendingDateStartedId = partner.id;
    document.getElementById("ds-modal-title").textContent = partner.name;
    var durationEl = document.getElementById("ds-duration-text");
    if (partner.dateStarted) {
      durationEl.textContent = durationMessage(partner);
      durationEl.style.display = "block";
    } else {
      durationEl.textContent = "";
      durationEl.style.display = "none";
    }
    document.getElementById("ds-date").value = partner.dateStarted || "";
    openModal("datestarted-modal");
  }

  // ---------- actions ----------
  function addPartner(data) {
    var p = {
      id: "p" + Date.now() + Math.floor(Math.random() * 1000),
      name: data.name,
      ministry: data.ministry,
      dateStarted: null,
      giving: false,
      givingAmount: 0,
      givingDate: null,
      prayed: false,
      scheduled: null
    };
    partners.push(p);
    // Redistribute everyone's scheduled date evenly across the cycle window
    // now that the total number of partners has changed.
    recomputeSchedule();
    save();
    render();

    if (data.giving) {
      openGivingModal(p, true);
    }
  }

  function reorderPartners(idsInOrder) {
    var map = {};
    partners.forEach(function (p) { map[p.id] = p; });
    var reordered = idsInOrder.map(function (id) { return map[id]; }).filter(Boolean);
    // Safety net: keep any partner not present in idsInOrder (shouldn't normally happen).
    partners.forEach(function (p) {
      if (reordered.indexOf(p) === -1) reordered.push(p);
    });
    // Keep prayed partners together at the top, unprayed below - dragging an
    // unprayed partner up above a prayed one just bumps them to the top of
    // the unprayed group instead of actually mixing the two groups.
    var prayedGroup = reordered.filter(function (p) { return p.prayed; });
    var unprayedGroup = reordered.filter(function (p) { return !p.prayed; });

    // Reassign the EXISTING pool of scheduled dates (sorted earliest-first)
    // to the unprayed group in their new order, rather than recalculating
    // fresh dates from scratch. This way reordering only changes who is due
    // on which date - it doesn't rescatter every date across the whole cycle
    // window each time someone gets moved.
    var existingDates = unprayedGroup
      .map(function (p) { return p.scheduled; })
      .filter(Boolean)
      .sort(function (a, b) { return parseISODate(a).getTime() - parseISODate(b).getTime(); });

    partners = prayedGroup.concat(unprayedGroup);

    if (existingDates.length === unprayedGroup.length) {
      unprayedGroup.forEach(function (p, i) { p.scheduled = existingDates[i]; });
    } else {
      // Fallback for the rare case a partner has no date yet - fall back to
      // a full recompute rather than leaving anyone undated.
      recomputeSchedule();
    }

    save();
    render();
  }

  function removePartner(id) {
    partners = partners.filter(function (p) { return p.id !== id; });
    // Redistribute the dates for the new total, like adding a partner does.
    recomputeSchedule();
    save();
    render();
  }

  function toggleGiving(id, checked) {
    var p = findPartner(id);
    if (!p) return;
    if (checked) {
      openGivingModal(p, false);
      // Revert checkbox visually until confirmed; if the user cancels, restore unchecked state.
    } else {
      p.giving = false;
      p.givingAmount = 0;
      p.givingDate = null;
      save();
      render();
    }
  }

  // The cycle's dates are fixed "slots" (the sorted set of every partner's
  // scheduled date). Ticking or un-ticking only moves PEOPLE between slots:
  //  - ticked: the partner goes to the bottom of the prayed group and takes the
  //    slot at that position (the next-up date); anyone who was above them in
  //    the unprayed list shifts down one slot, anyone below keeps their slot.
  //  - un-ticked: the partner returns to the top of the unprayed list with the
  //    next-up date, and everyone else shifts down one.
  // Slots are only recalculated by a new cycle or by adding/removing a partner.
  function moveToPrayedBoundary(p, makePrayed) {
    var slots = partners
      .map(function (x) { return x.scheduled; })
      .filter(Boolean)
      .sort(function (a, b) { return parseISODate(a).getTime() - parseISODate(b).getTime(); });

    partners = partners.filter(function (x) { return x.id !== p.id; });
    p.prayed = makePrayed;
    var insertIndex = partners.filter(function (x) { return x.prayed; }).length;
    partners.splice(insertIndex, 0, p);

    if (slots.length === partners.length) {
      partners.forEach(function (x, i) { x.scheduled = slots[i]; });
    } else {
      recomputeSchedule();
    }
  }

  // Marking someone as prayed (or un-praying them) moves them: prayed
  // partners collect at the top of the list in the order they were prayed
  // for, everyone else stays below them - and the remaining unprayed dates
  // reshuffle to match (see moveToPrayedBoundary above).
  function togglePrayed(id, checked) {
    var p = findPartner(id);
    if (!p) return;
    moveToPrayedBoundary(p, checked);
    save();
    render();
  }

  // Swiping the "Next up" card right marks that partner prayed for - same
  // effect as ticking their Prayed checkbox.
  function markPrayedFromCard(id) {
    var p = findPartner(id);
    if (!p) return;
    moveToPrayedBoundary(p, true);
    save();
    render();
  }

  // Swiping the "Next up" card left skips them for now: they move to the
  // bottom of the list and take the last date in the current schedule, while
  // everyone who was due after them moves up one slot to an earlier date.
  function skipFromCard(id) {
    var p = findPartner(id);
    if (!p) return;

    var queue = partners
      .filter(function (x) { return !x.prayed && x.scheduled; })
      .sort(function (a, b) { return parseISODate(a.scheduled).getTime() - parseISODate(b.scheduled).getTime(); });

    var idx = queue.indexOf(p);
    if (idx !== -1) {
      var dates = queue.map(function (x) { return x.scheduled; });
      for (var k = idx + 1; k < queue.length; k++) {
        queue[k].scheduled = dates[k - 1];
      }
      p.scheduled = dates[dates.length - 1];
    }

    partners = partners.filter(function (x) { return x.id !== id; });
    partners.push(p);

    save();
    render();
  }

  function findPartner(id) {
    for (var i = 0; i < partners.length; i++) {
      if (partners[i].id === id) return partners[i];
    }
    return null;
  }

  // ---------- drag reorder ----------
  function initDragReorder() {
    var tbody = document.getElementById("partners-tbody");
    var draggingEl = null;
    var startY = 0;

    function onPointerMove(e) {
      if (!draggingEl) return;
      var dy = e.clientY - startY;
      draggingEl.style.transform = "translateY(" + dy + "px)";

      var rows = Array.from(tbody.children);
      var idx = rows.indexOf(draggingEl);
      var pointerY = e.clientY;

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row === draggingEl) continue;
        var rect = row.getBoundingClientRect();
        var mid = rect.top + rect.height / 2;
        if (i < idx && pointerY < mid) {
          tbody.insertBefore(draggingEl, row);
          startY = e.clientY;
          draggingEl.style.transform = "translateY(0px)";
          break;
        } else if (i > idx && pointerY > mid) {
          tbody.insertBefore(draggingEl, row.nextSibling);
          startY = e.clientY;
          draggingEl.style.transform = "translateY(0px)";
          break;
        }
      }
    }

    function onPointerUp() {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      if (!draggingEl) return;
      draggingEl.style.transform = "";
      draggingEl.style.position = "";
      draggingEl.classList.remove("dragging");
      document.body.style.userSelect = "";

      var newOrderIds = Array.from(tbody.children).map(function (tr) { return tr.dataset.id; });
      draggingEl = null;
      reorderPartners(newOrderIds);
    }

    tbody.addEventListener("pointerdown", function (e) {
      var handle = e.target.closest('[data-role="drag-handle"]');
      if (!handle) return;
      var tr = handle.closest("tr");
      if (!tr) return;
      e.preventDefault();
      draggingEl = tr;
      startY = e.clientY;
      tr.style.position = "relative";
      tr.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    });
  }

  // ---------- next-up swipe gesture ----------
  function initNextUpSwipe() {
    var card = document.getElementById("next-up-card");
    var wrap = document.getElementById("next-up-wrap");
    var overlayPrayed = document.getElementById("overlay-prayed");
    var overlaySkip = document.getElementById("overlay-skip");
    var THRESHOLD = 90;
    var dragging = false;
    var startX = 0;
    var dx = 0;

    function setBadgeOpacity(amount) {
      var t = Math.min(Math.abs(amount) / THRESHOLD, 1);
      overlayPrayed.style.opacity = amount > 0 ? t : 0;
      overlaySkip.style.opacity = amount < 0 ? t : 0;
    }

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      dx = 0;
      card.classList.remove("snap-transition");
      card.classList.add("dragging");
      wrap.classList.add("revealed");
      if (card.setPointerCapture) {
        try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
    }

    function onPointerMove(e) {
      if (!dragging) return;
      dx = e.clientX - startX;
      var rotate = dx / 18;
      card.style.transform = "translateX(" + dx + "px) rotate(" + rotate + "deg)";
      setBadgeOpacity(dx);
    }

    function onPointerUp() {
      if (!dragging) return;
      dragging = false;
      card.classList.remove("dragging");
      wrap.classList.remove("revealed");
      var id = card.dataset.partnerId;
      var finalDx = dx;
      dx = 0;

      if (Math.abs(finalDx) >= THRESHOLD && id) {
        swipeAnimating = true;
        var direction = finalDx > 0 ? 1 : -1;
        var flyX = direction * (card.offsetWidth + window.innerWidth * 0.6);
        card.classList.add("snap-transition");
        card.style.transform = "translateX(" + flyX + "px) rotate(" + (direction * 18) + "deg)";
        card.style.opacity = "0";

        setTimeout(function () {
          if (direction > 0) {
            markPrayedFromCard(id);
          } else {
            skipFromCard(id);
          }
          // Snap instantly (no transition) to a slightly shrunk, invisible
          // state, then transition back to full size/opacity so the next
          // person's card feels like it's gently arriving.
          card.classList.remove("snap-transition");
          card.style.transition = "none";
          card.style.transform = "translateX(0) scale(0.96)";
          card.style.opacity = "0";
          void card.offsetWidth;
          card.classList.add("snap-transition");
          card.style.transform = "translateX(0) scale(1)";
          card.style.opacity = "1";
          setBadgeOpacity(0);

          setTimeout(function () { swipeAnimating = false; }, 300);
        }, 240);
      } else {
        card.classList.add("snap-transition");
        card.style.transform = "translateX(0) rotate(0deg)";
        setBadgeOpacity(0);
      }
    }

    card.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }

  // ---------- install as app ----------
  var deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  var INSTALL_GROUPS = {
    android: {
      title: "Android",
      steps: [
        "Tap your browser's menu (\u22ee or \u2630).",
        "Tap \u201cInstall app\u201d or \u201cAdd to Home screen.\u201d",
        "Confirm to finish."
      ]
    },
    apple: {
      title: "iPhone or iPad",
      steps: [
        "Tap the Share icon in Safari.",
        "Tap \u201cAdd to Home Screen.\u201d",
        "Tap \u201cAdd.\u201d"
      ]
    }
  };

  function detectPrimaryInstallGroup() {
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || "");
    return isIOS ? "apple" : "android";
  }

  function installGroupHTML(key) {
    var g = INSTALL_GROUPS[key];
    if (!g) return "";
    var items = g.steps.map(function (s) { return "<li>" + s + "</li>"; }).join("");
    return '<div class="install-group"><h5>' + g.title + "</h5><ol>" + items + "</ol></div>";
  }

  function isAlreadyInstalled() {
    return window.matchMedia && window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
  }

  function openInstallInstructions() {
    var primaryKey = detectPrimaryInstallGroup();
    var otherKey = primaryKey === "apple" ? "android" : "apple";
    var intro = document.getElementById("install-modal-intro");
    intro.textContent = isAlreadyInstalled()
      ? "Looks like you're already using the installed app!"
      : "Pick your device:";
    document.getElementById("install-steps-primary").innerHTML =
      installGroupHTML(primaryKey) + installGroupHTML(otherKey);
    openModal("install-modal");
  }

  // ---------- app icon badge ----------
  // Shows a count on the installed app's icon for partners due today or
  // overdue. Honest limitations: there's no server behind this app, so it
  // can only update the badge when the app is actually open (or reopened) -
  // it can't wake up in the background to refresh itself overnight. Browser
  // support is also inconsistent: it works on iOS/iPadOS 16.4+ (once
  // notification permission is granted) and on desktop Chrome/Edge/Safari,
  // but Android Chrome does not implement this API at all, so this won't do
  // anything visible there regardless of the setting.
  function dueTodayCount() {
    var today = todayAtMidnight();
    var count = 0;
    partners.forEach(function (p) {
      if (p.prayed || !p.scheduled) return;
      var d = parseISODate(p.scheduled);
      if (d && d.getTime() <= today.getTime()) count++;
    });
    return count;
  }

  function updateAppBadge() {
    if (!settings.badgeEnabled) return;
    if (!("setAppBadge" in navigator)) return;
    try {
      var count = dueTodayCount();
      if (count > 0) {
        navigator.setAppBadge(count).catch(function () {});
      } else {
        navigator.clearAppBadge().catch(function () {});
      }
    } catch (e) {
      // Not installed, insecure context, or permission not granted - ignore.
    }
  }

  function clearAppBadgeIfSupported() {
    if (!("clearAppBadge" in navigator)) return;
    try { navigator.clearAppBadge().catch(function () {}); } catch (e) { /* ignore */ }
  }

  function setBadgeEnabled(enabled) {
    settings.badgeEnabled = enabled;
    saveSettings();
    if (enabled) {
      // iOS requires notification permission before a badge will actually
      // show, even though we're not sending notifications ourselves.
      if (typeof Notification !== "undefined" && Notification.requestPermission) {
        try {
          Notification.requestPermission().then(function () { updateAppBadge(); });
        } catch (e) {
          updateAppBadge();
        }
      } else {
        updateAppBadge();
      }
    } else {
      clearAppBadgeIfSupported();
    }
  }

  // ---------- theme ----------
  function applyTheme(theme) {
    var resolved = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = resolved;
    // Also set this directly (in addition to the CSS `color-scheme` property
    // on :root) - some mobile browsers with their own forced dark/night mode
    // (Samsung Internet in particular) are more reliable about respecting a
    // page's chosen scheme when it's set as an inline style as well.
    document.documentElement.style.colorScheme = resolved;
    // Keep the browser chrome (status bar / toolbar) colour in sync with the
    // theme too - another small signal that this page genuinely supports
    // both schemes itself, rather than needing a browser-level override.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "dark" ? "#1E211C" : "#22301F");
    var label = document.getElementById("theme-toggle-label");
    if (label) label.textContent = resolved === "dark" ? "Light mode" : "Dark mode";
  }

  function toggleTheme() {
    settings.theme = settings.theme === "dark" ? "light" : "dark";
    saveSettings();
    applyTheme(settings.theme);
  }

  // ---------- backup: export / import ----------
  function exportData() {
    var payload = {
      exportedAt: new Date().toISOString(),
      app: "Partnership",
      version: 1,
      partners: partners,
      settings: settings
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var stamp = toISODate(todayAtMidnight());
    a.href = url;
    a.download = "partnership-backup-" + stamp + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showImportExportMessage("Backup downloaded.");
  }

  function importDataFromText(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      showImportExportMessage("That file doesn't look like a valid backup.");
      return;
    }
    if (!parsed || !Array.isArray(parsed.partners)) {
      showImportExportMessage("That file doesn't look like a valid backup.");
      return;
    }
    var proceed = confirm(
      "Importing will replace everything currently in the app (" + partners.length + " partner" +
      (partners.length === 1 ? "" : "s") + ") with " + parsed.partners.length +
      " partner" + (parsed.partners.length === 1 ? "" : "s") + " from the backup. Continue?"
    );
    if (!proceed) return;

    partners = parsed.partners;
    if (parsed.settings && typeof parsed.settings === "object") {
      settings.monthRange = [1, 2, 3].indexOf(parsed.settings.monthRange) !== -1 ? parsed.settings.monthRange : settings.monthRange;
      settings.lastShuffleMonthIndex = typeof parsed.settings.lastShuffleMonthIndex === "number" ? parsed.settings.lastShuffleMonthIndex : settings.lastShuffleMonthIndex;
      settings.theme = (parsed.settings.theme === "light" || parsed.settings.theme === "dark") ? parsed.settings.theme : settings.theme;
      settings.cycleEndDate = typeof parsed.settings.cycleEndDate === "string" ? parsed.settings.cycleEndDate : settings.cycleEndDate;
      settings.deferredUntilNewMonth = !!parsed.settings.deferredUntilNewMonth;
      settings.deferredMonthRange = [1, 2, 3].indexOf(parsed.settings.deferredMonthRange) !== -1 ? parsed.settings.deferredMonthRange : null;
      settings.lastPromptedForEndDate = typeof parsed.settings.lastPromptedForEndDate === "string" ? parsed.settings.lastPromptedForEndDate : null;
      settings.badgeEnabled = !!parsed.settings.badgeEnabled;
    }
    save();
    saveSettings();
    showImportExportMessage("Backup imported successfully.");
    document.getElementById("month-range").value = String(settings.monthRange);
    document.getElementById("badge-toggle-label").textContent =
      settings.badgeEnabled ? "On" : "Off";
    applyTheme(settings.theme);
    render();
  }

  function showImportExportMessage(text) {
    var el = document.getElementById("import-export-msg");
    if (!el) return;
    el.textContent = text;
    el.style.display = "block";
  }

  // ---------- events ----------
  function init() {
    load();
    applyTheme(settings.theme);
    // Any giving date already in the past rolls forward to its next monthly
    // occurrence so the giving tab always shows the upcoming date.
    var rolled = rollGivingDatesForward();
    // Once a month, reshuffle the partner order so the rotation doesn't always
    // land the same way (this only affects future "New cycle" distributions -
    // it never changes anyone's already-assigned scheduled date).
    var shuffled = shuffleForNewMonthIfNeeded();
    // Dates only change when a new cycle is explicitly started. The one
    // exception: a partner with no date at all yet (brand new, or legacy data)
    // gets a fallback slot so they still show up somewhere on the list.
    var missingSchedule = partners.filter(function (p) { return !p.prayed && !p.scheduled; });
    missingSchedule.forEach(function (p) { assignFallbackDate(p); });
    if (rolled || missingSchedule.length > 0 || shuffled) save();
    document.getElementById("month-range").value = String(settings.monthRange);
    document.getElementById("badge-toggle-label").textContent =
      settings.badgeEnabled ? "On" : "Off";
    var vEl = document.getElementById("app-version");
    if (vEl) vEl.textContent = "v" + APP_VERSION;
    render();
    initDragReorder();
    initNextUpSwipe();

    // If the current prayer cycle has run past its end date, ask whether to
    // start a new one now or wait for next month.
    if (isCycleEndPromptDue()) {
      document.getElementById("cycle-end-length").value = String(settings.monthRange);
      document.getElementById("cycle-end-timing").value = "today";
      openModal("cycle-end-modal");
    }

    // tabs
    var PAGE_CAPTIONS = {
      partners: "Joyful prayer in gospel partnership.",
      giving: "Cheerful giving from overflowing grace."
    };
    document.querySelectorAll("nav.tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("nav.tabs button").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        var view = btn.dataset.view;
        document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
        document.getElementById("view-" + view).classList.add("active");
        var caption = document.getElementById("page-caption");
        if (caption && PAGE_CAPTIONS[view]) caption.textContent = PAGE_CAPTIONS[view];
      });
    });

    // month range preference (applied when "New cycle" is pressed)
    document.getElementById("month-range").addEventListener("change", function (e) {
      var val = parseInt(e.target.value, 10);
      if ([1, 2, 3].indexOf(val) === -1) return;
      settings.monthRange = val;
      saveSettings();
    });

    // new cycle button
    document.getElementById("new-cycle-btn").addEventListener("click", function () {
      var val = parseInt(document.getElementById("month-range").value, 10);
      if ([1, 2, 3].indexOf(val) === -1) val = settings.monthRange;
      var label = val === 1 ? "1 month" : val + " months";
      var proceed = confirm("Start a new " + label + " prayer cycle?");
      if (!proceed) return;
      startNewCycle(val);
    });

    // settings modal
    document.getElementById("settings-btn").addEventListener("click", function () {
      document.getElementById("import-export-msg").style.display = "none";
      openModal("settings-modal");
    });

    // theme toggle
    document.getElementById("theme-toggle-btn").addEventListener("click", function () {
      toggleTheme();
    });

    // app icon badge toggle
    document.getElementById("badge-toggle-btn").addEventListener("click", function () {
      var next = !settings.badgeEnabled;
      setBadgeEnabled(next);
      document.getElementById("badge-toggle-label").textContent =
        next ? "On" : "Off";
    });

    // export / import
    document.getElementById("export-btn").addEventListener("click", function () {
      exportData();
    });
    document.getElementById("import-btn").addEventListener("click", function () {
      document.getElementById("import-file-input").click();
    });
    document.getElementById("import-file-input").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        importDataFromText(String(reader.result));
        e.target.value = "";
      };
      reader.onerror = function () {
        showImportExportMessage("Couldn't read that file.");
        e.target.value = "";
      };
      reader.readAsText(file);
    });

    // cycle-end prompt
    document.getElementById("cycle-end-confirm-btn").addEventListener("click", function () {
      var timing = document.getElementById("cycle-end-timing").value;
      var length = parseInt(document.getElementById("cycle-end-length").value, 10);
      if ([1, 2, 3].indexOf(length) === -1) length = settings.monthRange;

      if (timing === "today") {
        startNewCycle(length);
      } else {
        settings.deferredUntilNewMonth = true;
        settings.deferredMonthRange = length;
        settings.lastPromptedForEndDate = settings.cycleEndDate;
        saveSettings();
      }
      closeModal("cycle-end-modal");
    });

    // giving table sortable headers
    document.querySelectorAll("#view-giving th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        var col = th.dataset.sort;
        if (givingSort.column === col) {
          givingSort.dir = givingSort.dir === "asc" ? "desc" : "asc";
        } else {
          givingSort.column = col;
          givingSort.dir = "asc";
        }
        renderGivingTable();
      });
    });

    // fab
    document.getElementById("add-btn").addEventListener("click", function () {
      document.getElementById("add-form").reset();
      openModal("add-modal");
      setTimeout(function () { document.getElementById("f-name").focus(); }, 50);
    });

    // modal close buttons / backdrop
    document.querySelectorAll("[data-close]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var modalId = btn.dataset.close;
        closeModal(modalId);
        if (modalId === "giving-modal") {
          // user cancelled recording an amount; ensure state reflects "not giving"
          var p = findPartner(pendingGivingTargetId);
          if (p && !p.giving) {
            render(); // restores checkbox to unchecked
          }
          pendingGivingTargetId = null;
        } else if (modalId === "datestarted-modal") {
          pendingDateStartedId = null;
        }
      });
    });
    document.querySelectorAll(".modal-backdrop").forEach(function (backdrop) {
      backdrop.addEventListener("click", function (e) {
        if (e.target === backdrop) {
          backdrop.classList.remove("active");
          if (backdrop.id === "giving-modal") {
            var p = findPartner(pendingGivingTargetId);
            if (p && !p.giving) render();
            pendingGivingTargetId = null;
          } else if (backdrop.id === "datestarted-modal") {
            pendingDateStartedId = null;
          }
        }
      });
    });

    // add partner form
    document.getElementById("add-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("f-name").value.trim();
      var ministry = document.getElementById("f-ministry").value.trim();
      var giving = document.getElementById("f-giving").checked;
      if (!name || !ministry) return;
      closeModal("add-modal");
      addPartner({ name: name, ministry: ministry, giving: giving });
    });

    // giving amount form
    document.getElementById("giving-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var p = findPartner(pendingGivingTargetId);
      if (!p) { closeModal("giving-modal"); return; }
      var amount = parseFloat(document.getElementById("g-amount").value);
      var day = parseInt(document.getElementById("g-date-day").value, 10);
      p.giving = true;
      p.givingAmount = isNaN(amount) ? 0 : amount;
      p.givingDate = dateForDayInCurrentMonth(isNaN(day) ? todayAtMidnight().getDate() : day);
      pendingGivingTargetId = null;
      closeModal("giving-modal");
      save();
      render();
    });

    // date started form
    document.getElementById("ds-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var p = findPartner(pendingDateStartedId);
      if (!p) { closeModal("datestarted-modal"); return; }
      var val = document.getElementById("ds-date").value;
      p.dateStarted = val || null;
      pendingDateStartedId = null;
      closeModal("datestarted-modal");
      save();
      render();
    });

    // delegated table events
    document.getElementById("partners-tbody").addEventListener("change", function (e) {
      var target = e.target;
      var tr = target.closest("tr");
      if (!tr) return;
      var id = tr.dataset.id;
      if (target.dataset.action === "toggle-giving") {
        toggleGiving(id, target.checked);
      } else if (target.dataset.action === "toggle-prayed") {
        togglePrayed(id, target.checked);
      }
    });

    document.getElementById("partners-tbody").addEventListener("click", function (e) {
      var actionEl = e.target.closest("[data-action]");
      if (!actionEl) return;
      var tr = actionEl.closest("tr");
      if (!tr) return;
      var id = tr.dataset.id;
      var action = actionEl.dataset.action;
      if (action === "remove") {
        var p = findPartner(id);
        if (p && confirm("Remove " + p.name + " from your partners?")) {
          removePartner(id);
        }
      } else if (action === "edit-date-started") {
        var partner = findPartner(id);
        if (partner) openDateStartedModal(partner);
      }
    });

    document.getElementById("giving-tbody").addEventListener("click", function (e) {
      var target = e.target;
      if (target.dataset.action === "edit-giving") {
        var tr = target.closest("tr");
        var id = tr.dataset.id;
        var p = findPartner(id);
        if (p) openGivingModal(p, false);
      }
    });

    // service worker registration for PWA support.
    // Also actively checks for a newer version and reloads once it takes over,
    // so code changes show up on next launch instead of staying stuck on a
    // cached copy.
    if ("serviceWorker" in navigator) {
      var swRegistration = null;

      window.addEventListener("load", function () {
        navigator.serviceWorker
          .register("sw.js")
          .then(function (reg) {
            swRegistration = reg;
            reg.update();
            reg.addEventListener("updatefound", function () {
              var installing = reg.installing;
              if (!installing) return;
              installing.addEventListener("statechange", function () {
                if (installing.state === "installed" && navigator.serviceWorker.controller) {
                  installing.postMessage("skipWaiting");
                }
              });
            });
          })
          .catch(function () {
            // offline support just won't be available; app still functions
          });

        var reloadedOnce = false;
        navigator.serviceWorker.addEventListener("controllerchange", function () {
          if (reloadedOnce) return;
          reloadedOnce = true;
          window.location.reload();
        });
      });

      // Re-check for a newer version whenever the app is reopened or comes
      // back into view (e.g. switching back to this tab, or reopening the
      // installed app after it was in the background) - not just on the very
      // first load. This shrinks the window where a stale service worker
      // could otherwise sit around unnoticed during a long-lived session.
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && swRegistration) {
          swRegistration.update();
        }
      });
    }

    // Also refresh the app icon badge whenever the app is reopened/refocused,
    // independent of service worker support.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") updateAppBadge();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
