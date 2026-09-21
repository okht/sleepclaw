# Sleep investigation

SleepClaw combines user recollections with selected wearable records to explain one sleep question. Users can finish with incomplete information and revise their account later.

## Language

**Investigation**: One user-selected sleep question, with its own facts, target, questions and reports.
_Avoid_: A diagnosis, a generic chat thread with no subject

**Recollection**: What a user remembers, including their original uncertain wording or explicitly stated range. Precision is retained; approximate values are not promoted to measurements.
_Avoid_: Treating a recalled midpoint as an observed value

**Observation**: A source-attributed device record for a timestamp or interval. It remains distinct from the user's recollection and from a possible explanation.
_Avoid_: Ground truth, proof of a cause

**Target**: The explicitly selected sleep interval and source that constrain data analysis. Multiple devices are separate targets unless a future reconciliation method says otherwise.
_Avoid_: Automatically choosing the latest night

**Unobserved interval**: A portion of the selected interval with no usable sleep or awake label. It does not establish wakefulness.
_Avoid_: Zero sleep, awake by default

**Investigation plan**: A short, revisable set of checks and questions tied to the current facts. Once those facts change, the previous plan is stale until reviewed.
_Avoid_: A fixed mandatory questionnaire, private reasoning transcript

**Report revision**: A saved interpretation tied to a particular investigation revision. Corrected facts invalidate the previous report's current applicability without rewriting its history.
_Avoid_: Reusing an old conclusion after a correction
