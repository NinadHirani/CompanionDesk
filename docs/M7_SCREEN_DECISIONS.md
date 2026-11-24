# M7 decision brief: screen observation (open)

Nothing about capture has been built or enabled beyond b920187's
decision-independent groundwork. Both decisions below are yours alone;
nothing proceeds on either until you answer.

## Decision 1: what should screen observation actually do?

Only three honest shapes exist:

1. **On-demand only** (no background anything): observation runs when you
   click/ask ("what's on my screen?"), one shot, result shown, nothing
   stored. Safest; least useful as a companion.
2. **Triggered within a session**: while the companion is actively helping
   you on a task you started, it may look at the screen (bounded session,
   visible indicator), and stops the moment the session ends. Middle
   ground; still no independent background activity.
3. **Background assist**: it watches continuously in the background and
   offers help when it notices something. Most useful, most invasive,
   slowest to trust; needs an always-visible indicator and per-session
   or per-app scope rules you would have to define.

Trade-off in one line: value rises with intrusiveness; your standing
rules (opt-in, visible, no retention, no upload, no silent decisions)
apply to every shape, and shape 3 cannot be built acceptably without
more policy decisions from you than 1 or 2.

## Decision 2: interval, if anything recurring at all

Applies only to shapes 2-3. Options: manual (every look is you asking),
fixed slow cadence (e.g. every 30-60s while a session is active), or
event-driven (only on a signal such as a focus change). Faster intervals
buy responsiveness at the cost of CPU/battery and comfort; event-driven
is usually the right default because it observes only when something
changed, and we would default to manual for shape 2.

Answer when ready: "shape 1/2/3" and, if not 1, an interval preference.
No other question is bundled here.
