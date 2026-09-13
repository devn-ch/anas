/*
 * ANAS — Scrubs view (Epic 17: story 17.5).
 *
 * The periodic-SCRUB surface — uniform across ZFS and AHR, filesystem-native
 * backend. Split from the former single "Schedules" screen: the sibling Snapshots
 * view (69-snapshots.js) owns snapshot schedules; this owns periodic scrubs. Menu
 * label "Scrubs". The guiding principle (SCHEDULES-DESIGN.md): the operator
 * enables/disables a periodic scrub on a ZFS pool and an AHR pool through IDENTICAL
 * controls; only the backend differs.
 *
 * VISIBLE DIVERGENCE (never hidden): the AHR periodic scrub runs on ANAS's OWN
 * node-level `anas-scrub.timer` (story selfheal.4) — the WHOLE two-phase scrub
 * (phase 1 md parity, then phase 2 btrfs checksums + attribution) for every
 * enabled AHR pool, one pool at a time (pools share spindles), on a monthly or
 * quarterly cadence chosen in the toolbar beside the toggle. Enabling it takes
 * md checks over from mdadm's mdcheck timers (never double-scheduled); the
 * honest notes ride the Scope column and the toggle-confirm dialog.
 *
 * SECOND VISIBLE DIVERGENCE — the "Last scrub" column. ZFS records the verdict of
 * the last completed pass and we say it in words ("repaired 0 B, 0 errors — <date>
 * (took 5h 23m)"). md records NOTHING of the kind: no completion time, no result.
 * An AHR row therefore says so out loud instead of showing an empty cell — ANAS
 * does not mine journald and does not keep a state file to manufacture a record
 * it was never given (stateless — the system is the source of truth).
 *
 * STAGE 6 — the screen becomes a console. Run now / Stop verbs and live progress:
 *   - Run now / Stop reuse the EXISTING endpoints verbatim (a second door to the
 *     same routes the Pools and Hybrid RAID views drive — no second implementation).
 *   - While a pass runs, the Last scrub cell shows it ("scrubbing — 43.0% · …")
 *     instead of going quiet: ZFS keeps ONE scan record per pool, so during a pass
 *     there IS no verdict to print.
 *   - THIRD VISIBLE DIVERGENCE — Stop is ZFS-only. `zpool scrub -s` stops a scrub;
 *     the AHR scrub is a two-phase JOB (each band's md parity check, then the
 *     btrfs checksum scrub) with no cancel path in the daemon, and this story
 *     does not build one. The AHR row's Stop is disabled with the reason in its
 *     tooltip rather than silently missing.
 *
 * Data (paths relative to /v1 — see routes/scrub.ts):
 *   GET  /scrub                → { data: [ { target:{kind,pool}, enabled,
 *                                   cadence, mechanism, note?, nextRun?,
 *                                   phases?, lastScrub: {…}|null,
 *                                   running?: {function?,percent?,speedBytesSec?,
 *                                     etaSeconds?} } ] }
 *   PUT  /scrub/zfs/:pool  {enabled}  → flip the ZFS periodic-scrub property
 *   PUT  /scrub/ahr/:pool  {enabled, cadence?}  → edit the node timer's pool
 *                                   list (cadence is node-level, optional)
 *   POST /pools/:pool/scrub {action}  → start/stop a ZFS scrub (Epic 4.12's route)
 *   POST /ahr/:pool/scrub   {}        → AHR scrub job (Epic 11's route; no stop)
 *   GET  /jobs?status=completed       → the last AHR scrub's findings (selfheal.3)
 *
 * `running` is OPTIONAL on the wire: an older daemon omits it and every row then
 * renders exactly the verdict-only cell it renders today (additive-field skew rule).
 *
 * Shared with the Snapshots view via ANAS.sched.* (69-schedules-common.js): the
 * fs-tag chip, the state pills, and the visibility-gated poll loop — one place so
 * the two views read identically and never drift.
 *
 * SELFHEAL.3 — a finished AHR scrub names WHAT is corrupt. The daemon attributes
 * each kernel scrub warning to a file and probes the named 64 KiB stripe for the
 * exact failing 4 KiB blocks; the findings ride the scrub job's RESULT. A real
 * scrub runs for hours, well past the job-poll budget of the Run now that
 * started it, so the row finds them again through the daemon's own completed-job
 * list (`GET /jobs?status=completed`, filtered here — no new endpoint): the Last
 * scrub cell of an AHR pool whose last completed scrub found something says so
 * and opens the findings window. ONE door, ONE window — no second surface.
 *
 * FOURTH VISIBLE DIVERGENCE — that job list is IN MEMORY. It holds what has run
 * since anasd started and nothing older, and ANAS keeps no scrub history of its
 * own (stateless — no shadow state, nothing persisted), so the cell says "last
 * completed scrub since the daemon started" in those words rather than implying
 * a record the system does not keep. The PVE warning notification carries the
 * same paths and is what survives a restart.
 *
 * REPAIR FROM PARITY (selfheal.6) lives in that same window and nowhere else —
 * the findings are what a repair is selected FROM, so the verb belongs where
 * they are told. Tick the files to repair (a finding with no live file under
 * the mountpoint — deleted, or inside a snapshot — cannot be ticked and says
 * why), confirm what the daemon warns about, and the job's four honest counts
 * (repaired / unrepairable / above md / not corrupt at the mapped location —
 * review R9) come back into the same window. Never automatic, never a
 * read-path heal: an operator asks for it, on named files, with named blocks.
 *
 * …and on the TOOLBAR too (selfheal.9, RULED: both, gated by need). A Repair
 * action beside Run now / Stop is the verb's standing home — the window is a
 * detail surface an operator has to be told about, the toolbar is where the
 * eye already goes for pool verbs. One enablement rule drives both doors
 * (`repairableFinding`): lit only when the selected AHR pool's last completed
 * scrub holds at least one repairable finding, greyed with the reason on the
 * button otherwise. Clicking it opens the SAME window, the repairable rows
 * already ticked — the toolbar establishes what is repairable, the operator
 * only confirms.
 *
 * Test hooks: view cls 'anas-view anas-view-scrubs', grid cls 'anas-grid-scrub',
 * scrub toggle 'anas-btn-scrub-toggle', run 'anas-btn-scrub-run', stop
 * 'anas-btn-scrub-stop', toolbar repair 'anas-btn-scrub-repair' (selfheal.9),
 * findings window 'anas-win-scrub-findings' with grid
 * 'anas-grid-scrub-findings' (itemId '#findingsGrid'), repair button
 * 'anas-btn-repair-parity' and result panel '#repairResult'.
 *
 * Plain ES5 to match PVE's compiled ExtJS bundle — no build step, no deps.
 * Fail-open everywhere: a broken view renders an error panel, never breaks PVE.
 */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.ANAS || !window.ANAS.views) {
        return;
    }

    var ANAS = window.ANAS;

    // Shared schedules helpers (fs-tag chip, pills, poll loop) — ONE copy in
    // 69-schedules-common.js, used by both this view and the Snapshots view.
    var sched = ANAS.sched || {};

    function t(str) {
        return ANAS.t ? ANAS.t(str) : str;
    }

    function enc(s) {
        return ANAS.enc(s);
    }

    function pillHtml(label, color, title) {
        return sched.pillHtml(label, color, title);
    }

    function softPill(label, color, title) {
        return sched.softPill(label, color, title);
    }

    function muted(html) {
        return sched.muted(html);
    }

    // Absolute local timestamp — shared with the Snapshots view (one copy).
    function absTime(iso) {
        return sched.absTime ? sched.absTime(iso) : ('' + (iso || ''));
    }

    // A pass's wall-clock length, the "in 05:23:11" ZFS prints, said plainly:
    // "45s" / "12m" / "5h 23m" / "2d 3h". Empty for an unknown (0) duration so
    // the caller can drop the "(took …)" clause entirely rather than claim 0.
    function fmtDuration(seconds) {
        var s = Number(seconds);
        if (!isFinite(s) || s <= 0) {
            return '';
        }
        if (s < 60) {
            return Math.round(s) + 's';
        }
        var mins = Math.floor(s / 60);
        if (mins < 60) {
            return mins + 'm';
        }
        var hours = Math.floor(mins / 60);
        var restMins = mins % 60;
        if (hours < 24) {
            return hours + 'h' + (restMins ? ' ' + restMins + 'm' : '');
        }
        var days = Math.floor(hours / 24);
        var restHours = hours % 24;
        return days + 'd' + (restHours ? ' ' + restHours + 'h' : '');
    }

    // Set (or clear) a toolbar button's tooltip — the reason a verb is greyed
    // out belongs ON the button, never in a silent absence (the 30-pools idiom).
    function btnSetTip(btn, msg) {
        try {
            if (btn && typeof btn.setTooltip === 'function') {
                btn.setTooltip(msg || '');
            }
        } catch (e) {
            // non-fatal
        }
    }

    // Enable/disable any toolbar component (buttons AND the cadence combo) —
    // guarded so a component without Ext's method degrades to the property.
    function cmpSetDisabled(cmp, disabled) {
        try {
            if (!cmp) { return; }
            if (typeof cmp.setDisabled === 'function') {
                cmp.setDisabled(!!disabled);
            } else {
                cmp.disabled = !!disabled;
            }
        } catch (e) {
            // non-fatal
        }
    }

    // Read a combobox's value through Ext's accessor, falling back to the raw
    // property — the value belongs to the component, whichever shape it ships in.
    function comboValue(cmp) {
        try {
            if (cmp && typeof cmp.getValue === 'function') { return cmp.getValue(); }
        } catch (e) { /* fall through */ }
        return cmp ? cmp.value : undefined;
    }

    function comboSetValue(cmp, v) {
        try {
            if (cmp && typeof cmp.setValue === 'function') { cmp.setValue(v); return; }
        } catch (e) { /* fall through */ }
        if (cmp) { cmp.value = v; }
    }

    // ---- Row shape + renderers ---------------------------------------------

    function scrubRow(state, findingsByPool) {
        state = state || {};
        var target = state.target || {};
        var kind = target.kind || 'zfs';
        return {
            pool: target.pool,
            kind: kind,
            enabled: !!state.enabled,
            cadence: state.cadence || 'monthly',
            mechanism: state.mechanism || '',
            note: state.note || '',
            // The node timer's next fire (AHR; ISO, or null when off/unreadable)
            // and the two phases one scrub consists of (selfheal.4). Both absent
            // against an older daemon — the skew rule.
            nextRun: state.nextRun || null,
            phases: state.phases || null,
            // The last completed verify pass, or null when the filesystem keeps
            // no record of one (always so for AHR — see the header).
            lastScrub: state.lastScrub || null,
            // The pass running RIGHT NOW, or null when the pool is idle (and
            // always null against a daemon too old to report it).
            running: state.running || null,
            // The findings of this pool's NEWEST COMPLETED AHR scrub job, when
            // that job found something (selfheal.3). Null for ZFS, and null for
            // an AHR pool whose newest scrub was CLEAN — a clean pass displaces
            // an older one's findings — or whose jobs have aged out.
            findings: (kind === 'ahr' && findingsByPool) ? findingsFor(findingsByPool, target.pool) : null,
            // A stable per-row key (kind+pool) so selection survives a poll.
            rowKey: kind + ':' + (target.pool || '')
        };
    }

    // ---- Findings from the daemon's own job list (selfheal.3) ---------------
    //
    // A real scrub runs for hours — far past the job-poll budget of the Run now
    // that started it — so the findings have to be found again later. They are:
    // the AHR scrub job carries them in its RESULT, and the daemon already
    // exposes `GET /v1/jobs?status=completed`. The filtering (operation, pool,
    // newest-per-pool) is done here rather than asking the route for a filter
    // it does not have.
    //
    // The NEWEST completed `ahr.scrub` job per pool wins — findings OR NOT
    // (review, cut-but-verified): a later CLEAN scrub must displace an older
    // one's findings, or the row would advertise corruption a clean pass has
    // already ruled out. The row shows the entry only when that newest job
    // actually carries findings, so a clean scrub clears the indicator.
    //
    // The job queue is IN MEMORY: it holds what has run since anasd started and
    // nothing older, and ANAS keeps no scrub history of its own (stateless — no
    // shadow state). So the row says exactly that and never implies a record
    // the system does not keep.
    function jobTime(job) {
        var t = Date.parse(job.completedAt || job.startedAt || job.createdAt || '');
        return isFinite(t) ? t : 0;
    }

    function latestScrubByPool(res) {
        var byPool = {};
        var list = (res && res.data) || [];
        for (var i = 0; i < list.length; i++) {
            var job = list[i] || {};
            if (job.operation !== 'ahr.scrub' || job.status !== 'completed') {
                continue;
            }
            var result = job.result;
            var pool = result && result.scrubbed;
            if (!pool) {
                continue;
            }
            var prior = byPool[pool];
            if (!prior || jobTime(job) >= prior.at) {
                byPool[pool] = { at: jobTime(job), result: result };
            }
        }
        return byPool;
    }

    /** The findings entry for a row — null when the pool's newest scrub was clean. */
    function findingsFor(byPool, pool) {
        var entry = byPool[pool];
        if (!entry || !entry.result || !entry.result.findings || !entry.result.findings.length) {
            return null;
        }
        return entry;
    }

    // Pool: the shared fs-tag chip ("zfs"/"ahr") + the full pool name — reads
    // identically to the Snapshots target column (parallel construction).
    function renderScrubPool(v, meta, rec) {
        return sched.fsTag(rec.get('kind'))
            + '<span style="font-family:monospace;font-size:0.92em;">' + enc(rec.get('pool')) + '</span>';
    }

    function renderScrubEnabled(v, meta, rec) {
        if (rec.get('enabled')) {
            return pillHtml(t('On'), 'var(--anas-ok,#1f9c56)', t('periodic scrub is enabled'));
        }
        return softPill(t('Off'), 'var(--anas-muted,gray)', t('periodic scrub is disabled'));
    }

    // What the running pass is called. ZFS names it in the scan record (a
    // RESILVER is never called a scrub); md's check has no such name, so an AHR
    // row says "check running" — the words md itself uses.
    function runningLabel(kind, fn) {
        if (fn === 'RESILVER') {
            return t('resilvering');
        }
        if (fn === 'SCRUB') {
            return t('scrubbing');
        }
        return kind === 'ahr' ? t('check running') : t('scrubbing');
    }

    // The live pass, rendered IN PLACE of the verdict — while a pass runs there
    // is no verdict to show (ZFS keeps one scan record per pool and it currently
    // holds progress, not a result). Coloured accent (in progress), never
    // warn/ok: nothing has been judged yet.
    //
    // Every figure is optional and each is printed only when the filesystem
    // actually reported it — ZFS's scan record carries a percentage but neither
    // a rate nor a time-to-go, md's progress line carries all three. Absent
    // fields are simply left out; none is ever invented.
    function renderRunning(running, kind) {
        var parts = [];
        // A number ONLY when one was actually sent — an absent field must not
        // become a "0.0%" the filesystem never claimed.
        var num = function (v) {
            return typeof v === 'number' && isFinite(v) ? v : null;
        };
        var pct = num(running.percent);
        if (pct !== null) {
            parts.push(pct.toFixed(1) + '%');
        }
        var speed = num(running.speedBytesSec);
        if (speed !== null && speed > 0) {
            parts.push(ANAS.formatBytes(speed) + '/s');
        }
        var eta = fmtDuration(running.etaSeconds);
        if (eta) {
            parts.push(t('ETA') + ' ' + eta);
        }
        var title = kind === 'ahr'
            ? t('an md check is running — the figures cover the bands checking right now; '
                + 'any ETA is a floor, because bands still queued behind them are not counted')
            : t('a verify pass is running — ZFS records its progress but neither a rate nor a '
                + 'time-to-go, so only the percentage is shown');
        return '<span title="' + enc(title) + '" style="color:var(--anas-accent,#3468c0);">'
            + '<i class="fa fa-refresh" aria-hidden="true" style="margin-right:5px;"></i>'
            + enc(runningLabel(kind, running.function))
            + (parts.length ? enc(' — ' + parts.join(' · ')) : '')
            + '</span>';
    }

    // Last scrub: the VERDICT of the pool's last completed verify pass, in words
    // — "repaired 0 B, 0 errors — 2026-08-03 07:23 (took 5h 23m)". Anything
    // repaired or any error found is coloured warn: those are the rows an
    // operator should look at, and burying them in body text would hide them.
    //
    // Three honest absences, each said rather than left blank:
    //   AHR      — md keeps no completion record at all (nothing to report, ever).
    //   ZFS      — no pass on record yet (never scrubbed).
    //   canceled — a pass stopped early verified only PART of the pool, so its
    //              "0 errors" is not a clean bill of health and is never shown as one.
    function renderLastScrub(v, meta, rec) {
        // A pass in flight OUTRANKS the verdict cell: it is what is true now.
        // Absent (idle pool, or a daemon that doesn't report it) → everything
        // below renders byte-identically to before stage 6.
        var running = rec.get('running');
        if (running) {
            return renderRunning(running, rec.get('kind'));
        }

        // An AHR scrub that FOUND something outranks the "md keeps no record"
        // line: it is the one thing on this row an operator has to act on, and
        // it is the door to the file list (selfheal.3). The md caveat and the
        // in-memory scope both ride the tooltip rather than a second cell.
        var findings = rec.get('findings');
        if (findings) {
            var files = (findings.result.findings || []).length;
            return '<span class="anas-scrub-findings-link" style="color:var(--anas-warn,#b06a12);'
                + 'cursor:pointer;text-decoration:underline;" title="'
                + enc(t('the last AHR scrub that completed since the daemon started found checksum errors — '
                    + 'click to see the files and their bad blocks. ANAS keeps no scrub history of its own, '
                    + 'and md records no completion time or result for a check.')) + '">'
                + '<i class="fa fa-exclamation-triangle" aria-hidden="true" style="margin-right:5px;"></i>'
                + enc(files + ' ' + (files === 1 ? t('file with checksum errors') : t('files with checksum errors')))
                + '</span> <span style="color:var(--anas-muted,gray);">'
                + enc(t('— last completed scrub since the daemon started')) + '</span>';
        }

        var last = rec.get('lastScrub');
        if (!last) {
            if (rec.get('kind') === 'ahr') {
                // What the periodic scrub IS now (selfheal.4): the two phases it
                // runs, in order, and when the node timer fires next. "next"
                // only when the timer reports one (off/unreadable → absent).
                var phases = 'phase 1 parity (md) → phase 2 checksums (btrfs)';
                var next = rec.get('nextRun');
                var when = next ? '; ' + t('next') + ' ' + absTime(next) : '';
                var phaseTip = t('the periodic AHR scrub runs both phases, in this order: each band\'s '
                    + 'md parity check, then the btrfs checksum scrub that names corrupt files. '
                    + 'md records no completion time or result for a check; ANAS reports only '
                    + 'what the system records.');
                return '<span title="' + enc(phaseTip) + '">'
                    + enc(phases + when)
                    + ' <span style="color:var(--anas-muted,gray);">'
                    + '&mdash; ' + enc(t('(md keeps no completion record)')) + '</span></span>';
            }
            return '<span title="' + enc(t('ZFS reports no completed scrub or resilver for this pool')) + '">'
                + muted(enc(t('never scrubbed'))) + '</span>';
        }

        var when = absTime(last.finishedAt);
        if (last.state === 'CANCELED') {
            return '<span title="' + enc(t('the pass was stopped before it finished, so only part of the pool was verified'))
                + '" style="color:var(--anas-warn,#b06a12);">'
                + enc(t('canceled') + ' — ' + when) + '</span>';
        }

        // ZFS keeps ONE scan record per pool — a resilver overwrites the scrub's.
        // Name the pass that actually ran instead of calling a resilver a scrub.
        var resilver = last.function === 'RESILVER';
        var errors = Number(last.errors) || 0;
        var repaired = Number(last.repairedBytes) || 0;
        var verdict = (resilver ? t('resilvered') : t('repaired'))
            + ' ' + ANAS.formatBytes(repaired)
            + ', ' + errors + ' ' + (errors === 1 ? t('error') : t('errors'));
        var head = (repaired > 0 || errors > 0)
            ? '<span style="color:var(--anas-warn,#b06a12);">' + enc(verdict) + '</span>'
            : enc(verdict);

        var duration = fmtDuration(last.durationSeconds);
        var tail = '— ' + when + (duration ? ' (' + t('took') + ' ' + duration + ')' : '');
        var title = resilver
            ? t('the pool\'s last completed pass was a RESILVER, not a scrub — ZFS keeps one scan record per pool')
            : t('the pool\'s last completed scrub');
        return '<span title="' + enc(title) + '">' + head
            + ' <span style="color:var(--anas-muted,gray);">' + enc(tail) + '</span></span>';
    }

    // Scope: a narrow GLYPH column (stage 6). Only two states exist — a ZFS row
    // has no note (scrub is per-pool, the unremarkable case) and an AHR row
    // carries the one constant mdcheck node-global caveat — so a full-width
    // column of prose bought nothing but width the Last scrub column now needs.
    // The note is not lost: it is the icon's tooltip here, and it is still
    // spelled out in the toggle-confirm dialog, where it actually matters.
    function renderScrubScope(v, meta, rec) {
        var note = rec.get('note');
        if (!note) {
            return '';
        }
        return '<i class="fa fa-info-circle" aria-hidden="true" title="' + enc(note) + '"'
            + ' style="color:var(--anas-warn,#b06a12);"></i>';
    }

    // ---- Load / reload ------------------------------------------------------

    // `quiet` skips the loading mask so the timed poll refreshes in place; the
    // selected row is restored by rowKey (the replication pattern).
    function loadScrub(scrubGrid, node, quiet) {
        if (!scrubGrid || scrubGrid.destroyed || scrubGrid.destroying) {
            return;
        }
        if (!quiet) {
            try { scrubGrid.setLoading(true); } catch (e) { /* non-fatal */ }
        }
        var priorKey = null;
        try {
            var sel = scrubGrid.getSelectionModel().getSelection();
            priorKey = (sel && sel.length) ? sel[0].get('rowKey') : null;
        } catch (eS) {
            priorKey = null;
        }
        // Two reads, one render: the uniform scrub state, and the daemon's
        // completed jobs for the last AHR scrub findings (selfheal.3). The jobs
        // read is FAIL-OPEN — an older daemon, or a list that cannot be read,
        // costs the indicator and nothing else.
        var jobsRead = ANAS.api.get(node, '/jobs?status=completed').then(
            function (r) { return r; },
            function () { return null; }
        );
        Promise.all([ANAS.api.get(node, '/scrub'), jobsRead]).then(function (both) {
            var res = both[0];
            if (scrubGrid.destroyed || scrubGrid.destroying) {
                return;
            }
            if (!quiet) {
                try { scrubGrid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            var findingsByPool = {};
            try {
                findingsByPool = latestScrubByPool(both[1]);
            } catch (eJ) {
                ANAS.warn('scrub findings read failed: ' + ANAS.errText(eJ));
            }
            var list = (res && res.data) || [];
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push(scrubRow(list[i], findingsByPool));
            }
            try {
                scrubGrid.getStore().loadData(rows);
            } catch (e2) {
                ANAS.warn('scrub grid load failed: ' + ANAS.errText(e2));
            }
            if (priorKey) {
                try {
                    var idx = scrubGrid.getStore().findExact('rowKey', priorKey);
                    if (idx >= 0) {
                        scrubGrid.getSelectionModel().select(idx, false, true);
                    }
                } catch (eSel) {
                    // non-fatal
                }
            }
            updateScrubButtons(scrubGrid);
        }, function (err) {
            if (scrubGrid.destroyed || scrubGrid.destroying) {
                return;
            }
            if (!quiet) {
                try { scrubGrid.setLoading(false); } catch (e) { /* non-fatal */ }
            }
            ANAS.warn('scrub load failed: ' + ANAS.errText(err));
        });
    }

    // ---- Selection + toggle -------------------------------------------------

    function selectedScrub(scrubGrid) {
        var sel = scrubGrid ? scrubGrid.getSelection() : [];
        return (sel && sel.length) ? sel[0] : null;
    }

    // Selection-dependent toolbar state (the 30-pools idiom): Run now is off
    // while a pass already runs, Stop is on only when the selected row is
    // running something that CAN be stopped, and every greyed-out verb carries
    // the reason in its tooltip.
    function updateScrubButtons(scrubGrid) {
        var rec = selectedScrub(scrubGrid);
        var running = rec ? rec.get('running') : null;
        var kind = rec ? rec.get('kind') : null;
        var isAhr = !!rec && kind === 'ahr';

        var btn = scrubGrid.down('#scrubToggle');
        if (btn) {
            btn.setDisabled(!rec);
            if (rec) {
                var on = rec.get('enabled');
                btn.setText(on ? t('Disable scrub') : t('Enable scrub'));
                btn.setIconCls(on ? 'fa fa-pause' : 'fa fa-play');
                // The toggle's meaning, ON the button (selfheal.4): the ANAS
                // timer runs the whole two-phase scrub and takes mdcheck over.
                btnSetTip(btn, !isAhr ? '' : (on
                    ? t('removes this pool from the node\'s anas-scrub timer; the mdcheck timers stay off')
                    : t('adds this pool to the node\'s anas-scrub timer — phase 1 md parity, '
                        + 'then phase 2 btrfs checksums; mdadm\'s mdcheck timers are turned off')));
            }
        }

        // The cadence selector lives exactly where the toggle does — the toolbar,
        // enabled only for an AHR row (ZFS's cadence is PVE's monthly cron). It
        // rides the toggle body; there is no second control, no second dialog.
        // The 10 s poll must not yank the value out from under the operator
        // while they are choosing (review, cut-but-verified): a focused or
        // expanded picker is left alone, and the value is only ever rewritten
        // when it actually differs from the row's.
        var cad = scrubGrid.down('#scrubCadence');
        if (cad) {
            cmpSetDisabled(cad, !isAhr);
            if (isAhr) {
                var wanted = rec.get('cadence') || 'monthly';
                var busy = false;
                try { busy = cad.hasFocus === true; } catch (eF) { /* non-fatal */ }
                try { busy = busy || (typeof cad.isExpanded === 'function' && cad.isExpanded()); } catch (eX) { /* non-fatal */ }
                if (!busy && comboValue(cad) !== wanted) {
                    comboSetValue(cad, wanted);
                }
            }
        }

        var runBtn = scrubGrid.down('#scrubRun');
        if (runBtn) {
            runBtn.setDisabled(!rec || !!running);
            btnSetTip(runBtn, running ? t('a verify pass is already running on this pool') : '');
        }

        // Stop is ZFS-only, and that asymmetry is STATED, never silent: `zpool
        // scrub -s` stops a scrub, while the AHR scrub is a two-phase job (each
        // band's md parity check, then the btrfs checksum scrub) the daemon has
        // no cancel path for. A resilver cannot be stopped at all — same rule as
        // the Pools view.
        var stopBtn = scrubGrid.down('#scrubStop');
        if (stopBtn) {
            var reason = '';
            if (!rec) {
                reason = '';
            } else if (!running) {
                reason = t('nothing is running on this pool');
            } else if (kind === 'ahr') {
                reason = t('an AHR scrub cannot be stopped: it is a two-phase job '
                    + '(each band\'s md parity check, then the btrfs checksum scrub) '
                    + 'with no cancel path');
            } else if (running.function === 'RESILVER') {
                reason = t('a resilver cannot be stopped — only a scrub can');
            }
            stopBtn.setDisabled(!rec || !!reason);
            btnSetTip(stopBtn, reason);
        }

        // Repair from parity on the toolbar TOO (selfheal.9) — the verb's
        // standing home. Lit only for an AHR pool whose last completed scrub
        // holds at least one repairable finding, by the SAME rule the window's
        // button is lit by (repairableFindings); greyed with the reason ON the
        // button otherwise, each kind of silence said in its own words.
        var repairBtn = scrubGrid.down('#scrubRepair');
        if (repairBtn) {
            var entry = isAhr ? rec.get('findings') : null;
            var repairable = entry ? repairableFindings((entry.result || {}).findings) : [];
            var why = '';
            if (!rec || !isAhr) {
                why = t('select an AHR pool');
            } else if (!entry) {
                why = t('no scrub findings for this pool since the daemon started');
            } else if (!repairable.length) {
                why = t('findings cannot be repaired from here') + ': '
                    + blockedFindingReasons((entry.result || {}).findings).join(', ');
            }
            repairBtn.setDisabled(!rec || !!why);
            btnSetTip(repairBtn, why);
        }
    }

    function toggleScrub(node, scrubGrid, rec) {
        if (!rec) {
            return;
        }
        var kind = rec.get('kind');
        var pool = rec.get('pool');
        var next = !rec.get('enabled');
        var path = '/scrub/' + (kind === 'ahr' ? 'ahr' : 'zfs') + '/' + encodeURIComponent(pool);
        // The cadence rides the toggle body (node-level — the one timer carries
        // it); ZFS's request has no cadence, so its body stays { enabled }.
        var cadence = kind === 'ahr'
            ? (comboValue(scrubGrid.down('#scrubCadence')) || 'monthly')
            : undefined;

        var doToggle = function () {
            ANAS.runJob({
                node: node,
                method: 'put',
                path: path,
                body: kind === 'ahr' ? { enabled: next, cadence: cadence } : { enabled: next },
                view: scrubGrid,
                failTitle: 'Scrub toggle failed',
                successMsg: (next ? t('Periodic scrub enabled') : t('Periodic scrub disabled'))
                    + ': ' + pool,
                onComplete: function () { loadScrub(scrubGrid, node); }
            });
        };

        // The AHR toggle edits the NODE-LEVEL anas-scrub timer — confirm the
        // scope before flipping it: every enabled AHR pool is scrubbed by the
        // one timer, and enabling takes mdcheck over (never double-scheduled).
        if (kind === 'ahr') {
            try {
                Ext.Msg.confirm(
                    t('Periodic scrub (node-level timer)'),
                    (rec.get('note') ? (enc(rec.get('note')) + '<br><br>') : '')
                        + (next ? t('Enable') : t('Disable')) + ' '
                        + t('the ANAS scrub timer for this pool — the timer runs the whole scrub '
                            + '(phase 1 md parity, then phase 2 btrfs checksums) for every enabled '
                            + 'AHR pool on this node, one at a time?')
                        + (next
                            ? '<br><br>' + enc(t('mdadm\'s mdcheck timers will be turned off.'))
                                + '<br><br>' + enc(t('The timer is persistent: if this month\'s occurrence was already '
                                    + 'missed, enabling may START A SCRUB RIGHT AWAY — it can run for many hours.')) : ''),
                    function (btn) {
                        if (btn === 'yes') { doToggle(); }
                    }
                );
            } catch (e) {
                ANAS.warn('scrub confirm failed: ' + ANAS.errText(e));
            }
            return;
        }
        doToggle();
    }

    // ---- Scrub findings (story selfheal.3) ---------------------------------

    // A finished AHR scrub says WHAT is corrupt, not just how many errors: the
    // daemon attributes each kernel scrub warning to a file and reads the named
    // 64 KiB stripe block by block to find the failing 4 KiB ones. Those
    // findings ride the job result this screen ALREADY polls in runScrub, so
    // this is the one and only place they are shown — no second surface, no new
    // menu, and nothing at all when the scrub came back clean.
    //
    // Paths are never truncated. The line above the list carries the
    // reported-vs-attributed counts, because the kernel rate-limits its scrub
    // warnings: the attributed list is not always the whole story, and saying
    // so is the point.
    function findingsCounts(result, shown) {
        var parts = [];
        var attributed = Number(result.errorsAttributed);
        var reported = Number(result.errorsReported);
        if (isFinite(attributed) && isFinite(reported)) {
            parts.push(attributed + ' ' + t('of') + ' ' + reported + ' ' + t('reported error(s) attributed to a file'));
        }
        var orphans = Number(result.unattributed);
        if (isFinite(orphans) && orphans > 0) {
            parts.push(orphans + ' ' + t('error(s) name no file (read/IO or metadata)'));
        }
        if (result.truncated) {
            parts.push(t('only the first') + ' ' + shown + ' ' + t('files are listed'));
        }
        return parts.join(' · ');
    }

    function renderFindingPath(v, meta, rec) {
        var title = t('inode') + ' ' + rec.get('inode')
            + (rec.get('subvolume') ? (' · ' + t('subvolume') + ' ' + rec.get('subvolume')) : '');
        meta.tdAttr = 'data-qtip="' + enc(title) + '"';
        return '<span style="font-family:monospace;font-size:0.92em;">' + enc(rec.get('path')) + '</span>';
    }

    // The bad-block count, labelled by its column. Four findings have no plain
    // count to give and say WHY instead of showing a bare 0: a file deleted
    // between the scrub and the probe, a file outside the pool's mounted tree
    // (a scrub covers the whole filesystem, so a corrupt block inside a
    // snapshot is a real finding with no path under the mountpoint to read), a
    // COMPRESSED extent — the kernel's offset is extent-relative there, so the
    // count is the whole extent's blast radius, not a stripe probe (selfheal.8)
    // — and one whose corrupt block could not be named at all.
    //
    // T7 (third pass) marked the fact on the finding; this window renders it
    // (fourth pass): a probe made without the mapping searched an UNVERIFIED
    // window, so the blocks listed are real but not known to be complete. The
    // suffix rides the counted cells (plain and compressed) — the
    // `unidentified` cell already names the reason, and a missing or
    // in-snapshot file was never probed. Muted, with the reason as tooltip.
    function unverifiedSuffix(rec) {
        if (!rec.get('probedUnverified')) {
            return '';
        }
        var why = rec.get('reason') || '';
        return ' <span style="color:var(--anas-muted,gray);" title="'
            + enc(why) + '">'
            + enc(t('(search window unverified)')) + '</span>';
    }
    function renderFindingBlocks(v, meta, rec) {
        if (rec.get('outsideMount')) {
            return '<span style="color:var(--anas-muted,gray);" title="'
                + enc(t('the file is in a snapshot, beside the mounted subvolume — the scrub covers the '
                    + 'whole filesystem, and ANAS did not mount the top level to read it')) + '">'
                + enc(t('in a snapshot, outside the mounted tree')) + '</span>';
        }
        if (rec.get('missing')) {
            return '<span style="color:var(--anas-muted,gray);" title="'
                + enc(t('the path no longer exists — deleted since the scrub')) + '">'
                + enc(t('deleted since the scrub')) + '</span>';
        }
        if (rec.get('unidentified')) {
            var why = rec.get('reason') || '';
            return '<span style="color:var(--anas-muted,gray);" title="'
                + enc(t('the corruption is real — the kernel named this file — but no bad block could be named')
                    + (why ? (': ' + why) : '')) + '">'
                + enc(t('corrupt, block not identified')) + '</span>';
        }
        if (rec.get('compressed')) {
            var n = Number(rec.get('extentCount')) || 0;
            var tip = t('one corrupt sector of a compressed extent takes out the whole extent — its failing 4 KiB file blocks')
                + ': ' + (rec.get('blockList') || '');
            meta.tdAttr = 'data-qtip="' + enc(tip) + '"';
            return '<span style="color:var(--anas-warn,#b06a12);">'
                + enc(t('compressed extent — ') + n + t(' blocks')) + '</span>'
                + unverifiedSuffix(rec);
        }
        var n = Number(rec.get('blocks')) || 0;
        var list = rec.get('blockList');
        var tip = n
            ? (t('failing 4 KiB file blocks') + ': ' + list)
            : t('no block inside the reported stripe failed to read — the file was rewritten or repaired since the scrub');
        meta.tdAttr = 'data-qtip="' + enc(tip) + '"';
        return (n
            ? '<span style="color:var(--anas-warn,#b06a12);">' + n + '</span>'
            : muted('0'))
            + unverifiedSuffix(rec);
    }

    // ---- Repair from parity (selfheal.6) ------------------------------------
    //
    // A finding can be repaired only when there is a live file under the pool's
    // mountpoint to repair: a path deleted since the scrub has nothing left,
    // and a path inside a snapshot is outside the mounted tree (repair works on
    // the live @data tree in this cut). Both are refused by the daemon too —
    // this is the same rule said early, on the checkbox, so the operator is not
    // told after choosing. A finding whose probe found no bad block has nothing
    // to write either. A COMPRESSED finding repairs like any other — the
    // engine repairs the whole blob when handed any block of the extent, so
    // the request carries the extent's FIRST block (selfheal.8).
    function repairableRow(rec) {
        return repairableFinding(rec ? {
            missing: rec.get('missing'),
            outsideMount: rec.get('outsideMount'),
            unidentified: rec.get('unidentified'),
            blocks: rec.get('blocks')
        } : null);
    }

    function repairBlockedReason(rec) {
        if (rec.get('outsideMount')) {
            return t('this finding is inside a snapshot, outside the pool\'s mounted tree — '
                + 'repair works on the live @data tree only');
        }
        if (rec.get('missing')) {
            return t('the file no longer exists — it was deleted since the scrub named it');
        }
        if (rec.get('unidentified')) {
            var why = rec.get('reason') || '';
            return t('no bad block could be named for this corruption')
                + (why ? (' — ' + why) : '');
        }
        if (!Number(rec.get('blocks'))) {
            return t('no block inside the reported stripe failed to read — there is nothing to repair');
        }
        return '';
    }

    // THE enablement rule (selfheal.9) — ONE copy, said in two shapes. A finding
    // can be repaired only when there is a live file under the pool's mountpoint
    // to repair (not deleted, not inside a snapshot) and a bad block the probe
    // actually named (not unidentified, not a stripe that no longer fails). The
    // findings window's Repair column states it per row; the Scrubs toolbar
    // counts it across the pool's whole last-completed scrub — and both the
    // window's button and the toolbar's are lit by it, never by a second rule.
    function repairableFinding(f) {
        f = f || {};
        return !f.missing && !f.outsideMount && !f.unidentified && Number(f.blocks) > 0;
    }

    // The wire finding carries the probe's block array, the window row its count
    // — the two shapes meet here, the only place the rule is stated.
    function repairableFindings(findings) {
        var out = [];
        var list = findings || [];
        for (var i = 0; i < list.length; i++) {
            var f = list[i] || {};
            if (repairableFinding({
                missing: !!f.missing,
                outsideMount: !!f.outsideMount,
                unidentified: !!f.unidentified,
                blocks: (f.badBlocks || []).length
            })) {
                out.push(f);
            }
        }
        return out;
    }

    // Why a pool's findings leave the toolbar verb greyed out: the window's
    // per-row Repair-column reasons, counted by kind, so the tooltip says WHY
    // without the rule (or its words) being stated twice.
    function blockedFindingReasons(findings) {
        var counts = { deleted: 0, snapshot: 0, unnamed: 0, healed: 0 };
        var list = findings || [];
        for (var i = 0; i < list.length; i++) {
            var f = list[i] || {};
            if (f.missing) { counts.deleted++; }
            else if (f.outsideMount) { counts.snapshot++; }
            else if (f.unidentified) { counts.unnamed++; }
            else if (!Number((f.badBlocks || []).length)) { counts.healed++; }
        }
        var parts = [];
        var add = function (n, one, many) {
            if (n > 0) { parts.push(n + ' ' + (n === 1 ? one : many)); }
        };
        add(counts.deleted, t('file deleted since the scrub'), t('files deleted since the scrub'));
        add(counts.snapshot, t('finding in a snapshot, outside the mounted tree'),
            t('findings in snapshots, outside the mounted tree'));
        add(counts.unnamed, t('corruption whose bad block could not be named'),
            t('corruptions whose bad block could not be named'));
        add(counts.healed, t('file whose reported stripe no longer fails'),
            t('files whose reported stripes no longer fail'));
        return parts;
    }

    // The Repair column: what will happen, then what did. Before a run it is a
    // dash for a file that can be repaired and the reason for one that cannot;
    // after the job it carries that file's own outcome, counted per block.
    function renderRepairOutcome(v, meta, rec) {
        var blocked = repairBlockedReason(rec);
        if (!v) {
            if (blocked) {
                meta.tdAttr = 'data-qtip="' + enc(blocked) + '"';
                return muted(enc(t('cannot be repaired')));
            }
            return muted('—');
        }
        var color = v.level === 'ok' ? 'var(--anas-ok,#1f9c56)' : 'var(--anas-warn,#b06a12)';
        meta.tdAttr = 'data-qtip="' + enc(v.detail || v.text) + '"';
        return '<span style="color:' + color + ';">' + enc(v.text) + '</span>';
    }

    // The rows the daemon is asked about — full paths and the exact 4 KiB block
    // indexes the scrub probed, never "everything you think is bad". A
    // compressed finding rides as its extent's FIRST block: the engine repairs
    // the whole on-disk blob when handed any block of the extent, and one
    // request per extent says exactly what was asked, not 32 copies of it.
    function repairSelection(grid) {
        var out = [];
        var sel = grid.getSelection() || [];
        for (var i = 0; i < sel.length; i++) {
            if (!repairableRow(sel[i])) {
                continue;
            }
            if (sel[i].get('compressed') && Number(sel[i].get('extentFirst')) >= 0) {
                out.push({ path: sel[i].get('path'), blocks: [Number(sel[i].get('extentFirst'))] });
                continue;
            }
            out.push({ path: sel[i].get('path'), blocks: (sel[i].get('blockArray') || []).slice() });
        }
        return out;
    }

    function updateRepairButton(win) {
        var btn = win.down('#repairFromParity');
        var grid = win.down('#findingsGrid');
        if (!btn || !grid) {
            return;
        }
        var picked = repairSelection(grid);
        btn.setDisabled(!picked.length);
        btnSetTip(btn, picked.length
            ? ''
            : t('tick the files to repair — a finding with no live file under the mountpoint cannot be'));
    }

    // The job's answer, in the window the request was made from: the three
    // buckets, and each file's own outcome on its own row.
    function showRepairResult(win, job) {
        var panel = win.down('#repairResult');
        var grid = win.down('#findingsGrid');
        if (!panel) {
            return;
        }
        panel.setHidden(false);
        if (!job || job.status !== 'completed' || !job.result) {
            // A repair outruns the poll budget the same way a scrub does. Say
            // where the answer will be rather than inventing one here.
            panel.update(enc(t('The repair is still running. Its outcome arrives as a PVE notification, '
                + 'and the files above keep the findings that started it.')));
            return;
        }
        var res = job.result;
        var files = res.files || [];
        if (grid) {
            var store = grid.getStore();
            for (var i = 0; i < files.length; i++) {
                var idx = store.findExact('path', files[i].path);
                if (idx < 0) {
                    continue;
                }
                store.getAt(idx).set('outcome', fileOutcome(files[i]));
            }
        }
        var counts = Number(res.repaired || 0) + ' ' + t('repaired')
            + ' · ' + Number(res.unrepairable || 0) + ' ' + t('unrepairable')
            + ' · ' + Number(res.aboveMd || 0) + ' ' + t('above md')
            + ' · ' + Number(res.mappingAbort || 0) + ' ' + t('not corrupt at the mapped location')
            + ' (' + t('of') + ' ' + Number(res.blocks || 0) + ' ' + t('4 KiB block(s)') + ')';
        var lines = [enc(counts)];
        // Each bucket reads its own count (review R9): "restore from backup"
        // rides only the TRUE unrepairable. A mapping-abort block was never
        // corrupt at the mapped location — the engine wrote nothing, and the
        // advice is the opposite of a restore.
        if (Number(res.unrepairable || 0) > 0) {
            lines.push(enc(t('Unrepairable: nothing below the checksum tree can be proven right for '
                + 'those blocks — restore this file from backup.')));
        }
        if (Number(res.mappingAbort || 0) > 0) {
            lines.push(enc(Number(res.mappingAbort || 0) + ' ' + t('block(s) were not corrupt at the mapped location '
                + '— nothing was written, nothing to restore: the bytes there still pass their stored '
                + 'checksum, so the finding no longer describes them.')));
        }
        if (Number(res.aboveMd || 0) > 0) {
            lines.push(enc(t('Above md: parity already agreed with the bad data — this implicates '
                + 'something other than the disks (memory, controller, software). Nothing was written.')));
        }
        panel.update(lines.join('<br>'));
    }

    // One file's blocks, counted by bucket: "2 repaired", "1 repaired, 1
    // unrepairable". mapping-abort keeps its own name here — the count it feeds
    // is unrepairable, and the operator still sees "not corrupt here".
    function fileOutcome(file) {
        var blocks = file.blocks || [];
        var order = [];
        var byKind = {};
        var detail = [];
        for (var i = 0; i < blocks.length; i++) {
            var kind = blocks[i].outcome;
            if (!byKind[kind]) {
                byKind[kind] = 0;
                order.push(kind);
            }
            byKind[kind] += 1;
            detail.push(t('block') + ' ' + blocks[i].block + ': ' + kind + ' — ' + (blocks[i].reason || ''));
        }
        var parts = [];
        for (var j = 0; j < order.length; j++) {
            parts.push(byKind[order[j]] + ' ' + order[j]);
        }
        return {
            text: parts.join(', '),
            level: (order.length === 1 && order[0] === 'repaired') ? 'ok' : 'warn',
            detail: detail.join('\n')
        };
    }

    function repairFromParity(node, pool, win) {
        var grid = win.down('#findingsGrid');
        if (!grid) {
            return;
        }
        var files = repairSelection(grid);
        if (!files.length) {
            return;
        }
        var blocks = 0;
        for (var i = 0; i < files.length; i++) {
            blocks += files[i].blocks.length;
        }
        ANAS.confirmAndRun({
            node: node,
            method: 'post',
            path: '/ahr/' + encodeURIComponent(pool) + '/repair',
            body: { files: files },
            view: win,
            // A repair runs a bounded md check per block, so the budget is
            // minutes rather than the default seconds — and when it still runs
            // out, the window says so instead of claiming a result.
            maxMs: 120000,
            confirmTitle: t('Repair from parity'),
            confirmIntro: enc(t('Repairing') + ' ' + blocks + ' ' + t('block(s) in') + ' '
                + files.length + ' ' + t('file(s) on pool') + ' ' + pool + '. '
                + t('The daemon will:')),
            confirmButtonText: t('Repair'),
            failTitle: t('Repair failed'),
            onSubmitted: function () {
                ANAS.toast(t('Repair started on') + ' ' + pool);
                updateRepairButton(win);
            },
            onComplete: function (job) {
                try {
                    showRepairResult(win, job);
                } catch (e) {
                    ANAS.warn('repair result failed: ' + ANAS.errText(e));
                }
            }
        });
    }

    // The row's findings indicator is the door — a click anywhere ELSE on the
    // row is a plain selection. One door, one window.
    function onScrubItemClick(node, view, rec, item, index, e) {
        var entry = rec ? rec.get('findings') : null;
        if (!entry) {
            return;
        }
        var onLink = true;
        try {
            if (e && typeof e.getTarget === 'function') {
                onLink = !!e.getTarget('.anas-scrub-findings-link');
            }
        } catch (eT) {
            onLink = true;
        }
        if (!onLink) {
            return;
        }
        try {
            showScrubFindings(node, rec.get('pool'), entry.result);
        } catch (eW) {
            ANAS.warn('scrub findings failed: ' + ANAS.errText(eW));
        }
    }

    // `preselect` (selfheal.9) — the toolbar Repair opens this same window with
    // the repairable rows already ticked: the toolbar established what can be
    // repaired, the operator only confirms. The row indicator and the post-Run
    // auto-open leave the rows unticked, as ever.
    function showScrubFindings(node, pool, result, preselect) {
        var findings = (result && result.findings) || [];
        if (!findings.length) {
            return false;
        }
        var rows = [];
        for (var i = 0; i < findings.length; i++) {
            var f = findings[i] || {};
            var blocks = f.badBlocks || [];
            rows.push({
                path: f.path || '',
                subvolume: f.subvolume || '',
                inode: f.inode,
                blocks: blocks.length,
                blockList: blocks.join(', '),
                // The numbers themselves: what a repair request names, verbatim
                // from the probe — never re-derived here.
                blockArray: blocks.slice(),
                stripes: (f.stripes || []).length,
                missing: !!f.missing,
                outsideMount: !!f.outsideMount,
                // selfheal.8: the compressed extent's file block range (a
                // repair is handed its FIRST block), and the plain statement
                // of a corruption whose block could not be named.
                compressed: !!f.compressed,
                extentFirst: f.extentBlocks ? f.extentBlocks.first : -1,
                extentCount: f.extentBlocks ? f.extentBlocks.count : 0,
                unidentified: !!f.unidentified,
                reason: f.reason || '',
                probedUnverified: !!f.probedUnverified,
                outcome: null
            });
        }

        var win = Ext.create('Ext.window.Window', {
            cls: 'anas-win-scrub-findings',
            title: t('Scrub findings') + ' — ' + pool,
            modal: true,
            width: 720,
            height: 420,
            resizable: true,
            layout: { type: 'vbox', align: 'stretch' },
            items: [
                {
                    xtype: 'component',
                    padding: '10 12 6 12',
                    html: enc(t('These files failed checksum verification.') + ' ' + findingsCounts(result, rows.length))
                },
                {
                    xtype: 'gridpanel',
                    itemId: 'findingsGrid',
                    cls: 'anas-grid-scrub-findings',
                    flex: 1,
                    border: false,
                    // Repair is a per-file choice, so the rows are ticked one by
                    // one. SIMPLE mode: a click toggles, no modifier key to know.
                    selModel: { selType: 'checkboxmodel', mode: 'SIMPLE' },
                    store: Ext.create('Ext.data.Store', {
                        fields: ['path', 'subvolume', 'inode', 'blocks', 'blockList', 'stripes',
                            'missing', 'outsideMount', 'compressed', 'extentFirst', 'extentCount',
                            'unidentified', 'reason', 'probedUnverified',
                            { name: 'blockArray', type: 'auto' },
                            { name: 'outcome', type: 'auto' }],
                        data: rows
                    }),
                    columns: [
                        { text: t('File'), dataIndex: 'path', flex: 1, minWidth: 320,
                            sortable: false, menuDisabled: true, renderer: renderFindingPath },
                        { text: t('Bad 4K blocks'), dataIndex: 'blocks', width: 150, align: 'center',
                            sortable: false, menuDisabled: true, renderer: renderFindingBlocks },
                        { text: t('Repair'), dataIndex: 'outcome', width: 190,
                            sortable: false, menuDisabled: true, renderer: renderRepairOutcome }
                    ],
                    listeners: {
                        // A row with nothing to repair cannot be ticked at all —
                        // the Repair column carries the reason.
                        beforeselect: function (sm, rec) { return repairableRow(rec); },
                        selectionchange: function () { updateRepairButton(win); }
                    }
                },
                {
                    xtype: 'component',
                    itemId: 'repairResult',
                    cls: 'anas-scrub-repair-result',
                    hidden: true,
                    padding: '6 12 10 12',
                    html: ''
                }
            ],
            buttons: [
                {
                    text: t('Repair from parity'),
                    itemId: 'repairFromParity',
                    cls: 'anas-btn-repair-parity',
                    iconCls: 'fa fa-wrench',
                    disabled: true,
                    handler: function () { repairFromParity(node, pool, win); }
                },
                {
                    text: t('Close'),
                    handler: function () { win.close(); }
                }
            ]
        });
        win.show();
        if (preselect) {
            try {
                var fg = win.down('#findingsGrid');
                var sm = fg && typeof fg.getSelectionModel === 'function' ? fg.getSelectionModel() : null;
                if (sm && typeof sm.select === 'function') {
                    var recs = [];
                    var st = fg.getStore();
                    for (var k = 0; k < st.getCount(); k++) {
                        if (repairableRow(st.getAt(k))) {
                            recs.push(st.getAt(k));
                        }
                    }
                    if (recs.length) {
                        sm.select(recs, true, true);
                    }
                }
            } catch (eP) {
                // non-fatal — the rows stay unticked and the operator ticks them
            }
        }
        updateRepairButton(win);
        return true;
    }

    // ---- Run now / Stop -----------------------------------------------------

    // The on-demand verbs, driving the EXISTING per-filesystem scrub endpoints
    // verbatim — deliberately a second door to the routes the Pools (4.12) and
    // Hybrid RAID (11.x) views already use, never a second implementation. Those
    // views keep their own buttons; this screen just puts them where the scrub
    // story is told.
    //
    // Every safety rule stays where it belongs — in the API (Principle 14): the
    // daemon 409s a scrub on a resilvering ZFS pool or a degraded/busy/unmounted
    // AHR pool, and runJob shows that message. The screen gates only on what it
    // can honestly see: whether a pass is already running.
    function runScrub(node, scrubGrid, rec, stop) {
        if (!rec) {
            return;
        }
        var kind = rec.get('kind');
        var pool = rec.get('pool');
        var zfs = kind !== 'ahr';
        ANAS.runJob({
            node: node,
            method: 'post',
            path: zfs
                ? '/pools/' + encodeURIComponent(pool) + '/scrub'
                : '/ahr/' + encodeURIComponent(pool) + '/scrub',
            // ZFS takes the start/stop action; the AHR scrub route takes no body.
            body: zfs ? { action: stop ? 'stop' : 'start' } : {},
            view: scrubGrid,
            failTitle: stop ? 'Stop scrub failed' : 'Scrub failed',
            // A scrub runs for hours — the 202 is the news, not the completion,
            // so say it (and pick up the running state) the moment it lands.
            onSubmitted: function () {
                ANAS.toast((stop ? t('Stopping scrub on') : t('Scrub started on')) + ' ' + pool);
                loadScrub(scrubGrid, node, true);
            },
            onComplete: function (job) {
                loadScrub(scrubGrid, node, true);
                // An AHR scrub that FINISHED while this screen was still
                // polling opens its findings straight away. A scrub still
                // running when the budget ends (the usual case on real disks:
                // the budget is seconds, the scrub is hours) reaches the row
                // instead — the reload above re-reads the completed-job list,
                // so the findings land in the Last scrub cell the moment the
                // job finishes, and in the PVE notification either way.
                if (zfs || stop || !job || job.status !== 'completed') {
                    return;
                }
                try {
                    showScrubFindings(node, pool, job.result);
                } catch (e) {
                    ANAS.warn('scrub findings failed: ' + ANAS.errText(e));
                }
            }
        });
    }

    // ---- View ---------------------------------------------------------------

    function scrubsView(node) {
        var store = Ext.create('Ext.data.Store', {
            fields: ['pool', 'kind', 'cadence', 'mechanism', 'note', 'rowKey',
                { name: 'enabled', type: 'auto' },
                { name: 'nextRun', type: 'auto' },
                { name: 'phases', type: 'auto' },
                { name: 'lastScrub', type: 'auto' },
                { name: 'running', type: 'auto' },
                { name: 'findings', type: 'auto' }],
            data: [],
            sorters: [{ property: 'kind', direction: 'ASC' }, { property: 'pool', direction: 'ASC' }]
        });

        // Reload just this view's grid (the poll loop lives in ANAS.sched).
        var refresh = function (view, quiet) {
            try {
                var g = view.down('#scrubGrid');
                if (g) { loadScrub(g, node, quiet); }
            } catch (e) {
                ANAS.warn('scrubs refresh failed: ' + ANAS.errText(e));
            }
        };

        return {
            xtype: 'panel',
            cls: 'anas-view anas-view-scrubs',
            title: t('Scrubs'),
            layout: { type: 'vbox', align: 'stretch' },
            border: false,
            items: [
                {
                    // xtype 'grid' (= Ext.grid.Panel; 'gridpanel' is its alias) —
                    // the toolbar handlers resolve their grid via up('grid').
                    xtype: 'grid',
                    itemId: 'scrubGrid',
                    cls: 'anas-grid-scrub',
                    flex: 1,
                    border: false,
                    store: store,
                    selModel: { mode: 'SINGLE' },
                    emptyText: t('No pools found'),
                    columns: [
                        { text: t('Pool'), dataIndex: 'pool', flex: 1, minWidth: 160,
                            sortable: false, menuDisabled: true, renderer: renderScrubPool },
                        { text: t('Periodic scrub'), dataIndex: 'enabled', width: 120, align: 'center',
                            renderer: renderScrubEnabled },
                        { text: t('Cadence'), dataIndex: 'cadence', width: 110,
                            renderer: function (v) { return enc(v || 'monthly'); } },
                        // Widened with the room the Scope column gave back — this
                        // is where the live-progress strip now lives.
                        { text: t('Last scrub'), dataIndex: 'lastScrub', flex: 2, minWidth: 340,
                            sortable: false, menuDisabled: true, renderer: renderLastScrub },
                        { text: t('Scope'), dataIndex: 'note', width: 70, align: 'center',
                            sortable: false, menuDisabled: true, renderer: renderScrubScope }
                    ],
                    tbar: ANAS.tbar([
                        {
                            text: t('Reload'),
                            cls: 'anas-btn-refresh',
                            iconCls: 'fa fa-refresh',
                            handler: function (btn) {
                                var g = btn.up('panel').down('#scrubGrid');
                                if (g) { loadScrub(g, node, false); }
                            }
                        },
                        '-',
                        {
                            // The cadence of the node's AHR scrub timer — node-level,
                            // so ONE selector beside the toggle covers every pool; it
                            // rides the toggle body rather than being a second verb.
                            xtype: 'combobox',
                            itemId: 'scrubCadence',
                            cls: 'anas-cmb-scrub-cadence',
                            width: 110,
                            editable: false,
                            forceSelection: true,
                            queryMode: 'local',
                            store: [['monthly', t('Monthly')], ['quarterly', t('Quarterly')]],
                            value: 'monthly',
                            disabled: true
                        },
                        {
                            xtype: 'component',
                            html: enc(t('Verify pools periodically. ZFS: PVE\'s monthly cron, per-pool. '
                                + 'AHR: the ANAS timer (monthly/quarterly) — phase 1 md parity, then '
                                + 'phase 2 btrfs checksums, pools one at a time.')),
                            style: 'color:var(--anas-muted,gray);font-size:11px;'
                        },
                        '->',
                        {
                            text: t('Run now'),
                            itemId: 'scrubRun',
                            cls: 'anas-btn-scrub-run',
                            iconCls: 'fa fa-play-circle',
                            disabled: true,
                            handler: function (btn) {
                                var g = btn.up('grid');
                                runScrub(node, g, selectedScrub(g), false);
                            }
                        },
                        {
                            text: t('Stop'),
                            itemId: 'scrubStop',
                            cls: 'anas-btn-scrub-stop',
                            iconCls: 'fa fa-stop',
                            disabled: true,
                            handler: function (btn) {
                                var g = btn.up('grid');
                                runScrub(node, g, selectedScrub(g), true);
                            }
                        },
                        {
                            // Repair from parity, from the grid (selfheal.9). The
                            // same window the row indicator opens — the repairable
                            // rows arrive preselected, so the operator only
                            // confirms what the toolbar already established.
                            text: t('Repair'),
                            itemId: 'scrubRepair',
                            cls: 'anas-btn-scrub-repair',
                            iconCls: 'fa fa-wrench',
                            disabled: true,
                            handler: function (btn) {
                                var g = btn.up('grid');
                                var rec = selectedScrub(g);
                                var entry = rec && rec.get('kind') === 'ahr' ? rec.get('findings') : null;
                                if (!entry) {
                                    return;
                                }
                                try {
                                    showScrubFindings(node, rec.get('pool'), entry.result, true);
                                } catch (e) {
                                    ANAS.warn('scrub findings failed: ' + ANAS.errText(e));
                                }
                            }
                        },
                        '-',
                        {
                            text: t('Enable scrub'),
                            itemId: 'scrubToggle',
                            cls: 'anas-btn-scrub-toggle',
                            iconCls: 'fa fa-play',
                            disabled: true,
                            handler: function (btn) {
                                var g = btn.up('grid');
                                toggleScrub(node, g, selectedScrub(g));
                            }
                        }
                    ]),
                    listeners: {
                        selectionchange: function () { updateScrubButtons(this); },
                        itemclick: function (view, rec, item, index, e) {
                            onScrubItemClick(node, view, rec, item, index, e);
                        }
                    }
                }
            ],
            // Refresh + visibility-gated poll loop live in ANAS.sched (shared).
            listeners: sched.viewListeners(refresh)
        };
    }

    // ---- View registration -------------------------------------------------

    ANAS.views['scrubs'] = {
        itemId: 'anas-scrubs',
        text: t('Scrubs'),
        iconCls: 'fa fa-refresh',
        factory: function (node) {
            try {
                return scrubsView(node);
            } catch (e) {
                ANAS.warn('scrubs view failed: ' + ANAS.errText(e));
                return ANAS.errorPanel(ANAS.errText(e));
            }
        }
    };
})();
