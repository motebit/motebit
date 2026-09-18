---
"motebit": minor
---

The record that lets a late goal say why — increment 4a of unattended execution.

`GoalScheduler` fires a goal on `elapsed >= interval_ms`. So a daily goal whose machine slept from 01:00 to 09:00 does not fail: it fires at 09:00, six hours late, and nothing anywhere says the motebit was not running. That is a record untrue by omission — the class this whole arc has been removing — arriving through the host layer rather than the routing layer.

**The distinction is the point.** Late because the machine was asleep is the host's story, and its owner can act on it by hosting somewhere that stays awake. Late because the machine was _awake_ and the goal did not fire is a scheduler defect — and it has been completely invisible, because both look identical in the record. A coverage record that could only explain the first would quietly absorb the second into it. So a late run's note now says which: _"fired 6h late — nothing was hosting you 01:00–09:00"_, or _"fired 6h late, and this machine was awake when it was due — that is not a hosting gap"_.

A third answer exists and is deliberate: a surface that wrote no liveness gets _nothing extra_, never a guess. "We do not know" is not "you were hosted", and inventing either would be the same omission one layer up.

**Shape.** One row per process-run rather than per machine, so a restart is a new row and the seam between sessions stays visible instead of being smoothed over by a bumped timestamp. `last_seen_at` is refreshed on the same tick that fires goals, so the record of being awake and the firing it explains cannot drift apart — and it is written at the _top_ of the tick, because being awake is a fact about the instant rather than about whether the work that followed succeeded. A gap shorter than a couple of ticks is not a gap: `last_seen_at` lags by up to one tick and a restart costs another, so treating that seam as downtime would tell an owner their motebit slept when it did not.

The scheduler says only "I am awake"; the caller knows which device and which executor that refers to, and the scheduler has no other use for that identity. A liveness write that fails is swallowed: this record explains lateness, it is not load-bearing for doing the work.

**Coverage is per MACHINE, and deliberately not summed across a motebit's machines.** These rows live in the database of the machine that wrote them, so a laptop's reader can only ever answer for the laptop. The union across machines — the shape this arc is aiming at, where a motebit's uptime is the union of its machines' uptimes — needs the same cross-machine plumbing as coordinator handoff. Named rather than faked.

**Not shipped here:** the service installer. Increment 4's decision (issue #685) says its content is the coverage record rather than the plist, and the record is worth having on its own — people already run `motebit run` by hand, and a goal that fires late says nothing today. The installer is also what makes two-machine setups easy, and a remote `halt` is currently refused on two machines, so it should not land before that story is whole.

Found and fixed alongside: a persistence test hardcoded the latest migration version, with a comment asking the next person to bump it "so CI catches a forgotten version bump in the migrate block". There is no such block — `runMigrations` derives the version from the registry — so the literal guarded nothing and failed on every migration. It asserts the relationship now.
