# Internal experience configuration

The first release keeps all new features disabled by default. It preserves the
existing 15-minute cycle, sleep rules and single-instance StateStore. No database
migration or new external memory service is required.

## Initial release

Keep `SHADOW_MODE=true` and legacy `MODEL_ENABLED`, `BARK_ENABLED`,
`BRIDGE_ENABLED` false. The following switches must remain false (or unset,
which defaults to false) until separately approved:

- `EXPERIENCE_ENABLED`
- `EXPERIENCE_MATERIAL_ENABLED`
- `EXPERIENCE_MODEL_ENABLED`
- `EXPERIENCE_THOUGHT_ENABLED`
- `EXPERIENCE_DAYTIME_ENABLED`
- `EXPERIENCE_HANDOFF_ENABLED`

Adding a model credential does not enable any feature. Do not change heartbeat,
chat cache, device presence or notification settings as part of this release.

## Model and materials

| Setting | Default |
|---|---|
| EXPERIENCE_AGENT_ID | ethan |
| EXPERIENCE_MODEL_NAME | deepseek-v4-flash |
| EXPERIENCE_MODEL_BASE_URL | https://api.deepseek.com |
| EXPERIENCE_MODEL_API_KEY | empty; configure privately |
| EXPERIENCE_MODEL_TIMEOUT_MS | 15000 |
| EXPERIENCE_MODEL_MAX_INPUT_CHARS | 3000 |
| EXPERIENCE_MODEL_MAX_OUTPUT_TOKENS | 650 |
| EXPERIENCE_MIN_MATERIAL_CHARS | 16 |
| EXPERIENCE_EVENT_TTL_MINUTES | 120 |

Only the official Flash routes are allowed; `deepseek-flash` is also accepted.
Thinking is disabled. Invalid output, timeout and failure never fall back to
Opus or the legacy model. Failed dream generation preserves a rule dream;
failed thought/daytime attempts are recorded without invented text.

Material is a read-only projection of unexpired handoff notes, textual flash and
ongoing thoughts, and prior internal experiences. Numeric drives, fatigue and
consciousness are background state and do not satisfy the text threshold.
Labels are not counted. Dreams are marked as internal, not external facts, and
cannot alone seed a model call. Current-cycle experiences are excluded from
that cycle's material. No Ombre requests are made by the experience runner.
The original trigger gates still apply, so a cycle may make zero model requests.

Dream, thought and daytime experiences are separately appended to the state
ledger before arbitration. Declining, selecting, expiring or acknowledging an
outward candidate does not delete those experiences. Each persisted cycle has
one stable ID and at most one event `proactive:<agentId>:<cycleId>`. A restarted
unknown model attempt is marked ambiguous rather than retried.

## Candidate API and rollout

Existing service-token authentication protects `GET /v1/proactive/pending` and
`POST /v1/proactive/ack`. With handoff disabled, authenticated requests return
404 `proactive handoff disabled`; missing or invalid authentication returns 401.
No ACK write is necessary for the initial disabled-release checks.

After separate approval, enable internal experience switches with handoff still
false. Only later enable handoff and gateway polling under coordinator dry-run.
Dry-run resolves an event; it will not be sent again after dry-run is disabled.
The gateway adapter is a separate release and must use the same agent ID and
existing service token. This repository does not publish or enable that adapter.

## Rollback

Disable gateway candidate polling first, then experience handoff and experience
generation. Keep legacy routes off and shadow mode on. In-flight requests may
finish before their timeout; switches do not cancel an already started request.
Preserve the state ledger when reverting code. Restoring an older state snapshot
is a separate data recovery operation and can discard newer experiences.
