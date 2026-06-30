# Tasks (canonicalized)

Purpose
-------

Registrar trabajo atómico, priorizado y trazable. Este archivo es la fuente canónica
de tareas sobre la que se basan la planificación y las decisiones operativas.

Status legend
-------------

- `pending` — no empezada
- `in_progress` — en curso
- `completed` — terminada
- `cancelled` — ya no aplica

Conventions
-----------

- Cada tarea tiene: ID, estado, prioridad, título, estimate (horas/días), criterios de aceptación y referencias.
- Las tareas se agrupan por Epic para facilitar la planificación.
- Para marcar una tarea como `completed` ejecutar la validación correspondiente (`npm run validate`) y usar `scripts/complete_task_if_valid.sh "<exact task line>"`.

NOTA: Esta versión consolida entradas previas y elimina duplicados. Las referencias históricas se preservan en `docs/CHANGELOG.md` y `AI_HANDOFF.md`.

---

Epic: Core Conceptual Model (PRIORIDAD: CRITICAL)
------------------------------------------------

| ID | Status | Pri | Title | Estimate | Acceptance Criteria | References |
| --- | --- | --- | --- | ---: | --- | --- |
| CORE-001 | in_progress | critical | Completar la migración definitiva Universe → World en dominio, API y documentación | 1–2d | No queda ninguna ambigüedad terminológica. Universe representa el servidor. World representa el entorno creado por el usuario. | docs/TERMINOLOGY.md |
| CORE-002 | completed | critical | Implementar Context Builder como responsabilidad explícita del núcleo | 2–3d | Todo prompt enviado a la IA es generado exclusivamente por el Context Builder utilizando Mundo, Personajes, Memorias e Historial. | docs/ARCHITECTURE.md |
| CORE-003 | completed | critical | Separar completamente la generación de contexto de la ejecución del proveedor IA | 1d | El proveedor únicamente recibe un contexto ya construido. | docs/ARCHITECTURE.md |
| CORE-004 | pending | high | Definir el modelo oficial de memoria de Mundo y Personajes | 1–2d | Existe una estrategia única para memoria global, memoria individual y selección de contexto. | docs/ARCHITECTURE.md |
| CORE-005 | pending | high | Diseñar el Simulation Engine basado en eventos persistentes | 2–4d | El motor puede evolucionar un Mundo utilizando únicamente eventos, contexto y reglas del Mundo. | docs/ROADMAP.md |
| CORE-006 | pending | high | Definir la estrategia oficial de construcción de contexto | 1d | Documentado cómo se seleccionan reglas, memoria, historial y contexto para cada interacción. | docs/ARCHITECTURE.md |

Epic: Auth & Accounts (PRIORIDAD: HIGH) — estado: in_progress
---------------------------------------------------------------

| ID | Status | Pri | Title | Estimate | Acceptance Criteria | References |
| --- | --- | --- | --- | ---: | --- | --- |
| AUTH-001 | completed | high | Envío SMTP para magic-link (pluggable, nodemailer) | 1.5d | Env vars documentadas; en prod SMTP se usa; en dev `WORLDCORE_ALLOW_DEV_MAGIC_LINK=1` devuelve devToken; token persistido hashed; email contiene enlace verificable; tests unit + integration pasan | docs/AUTHENTICATION.md |
| AUTH-002 | completed | high | Mock SMTP y pruebas E2E para magic-link | 0.5d | Mock SMTP captura correo y el flujo verify consume token; integrado en validación local | tests/adapters/magic_link.test.ts |
| AUTH-003 | completed | medium | Rate-limit por email/IP para magic-link/send (configurable) | 0.5d | Límites aplicables; pruebas que simulan abuso y bloqueo | docs/AUTHENTICATION.md, server.ts |
| AUTH-004 | completed | medium | Habilitar Argon2 y verificar migración desde PBKDF2 | 0.5d | Rehash-on-login funciona; tests de migración disponibles y pasan cuando argon2 está presente | src/utils/password.ts, tests/adapters/password_migration.test.ts |
| AUTH-005 | completed | medium | UX + tests de refresh token (rotación y revocación) | 0.5d | UI refleja estado; /api/auth/refresh rota; /api/auth/revoke borra tokens; E2E cubre flujo | server.ts, /play UI |
| AUTH-006 | pending | medium | Admin-unlock endpoint y pruebas | 0.5d | Admins pueden desbloquear cuentas; pruebas unit/integration | server.ts, docs/PERMISSIONS.md |
| AUTH-007 | pending | medium | Integración OAuth (Google/GitHub) bajo feature-flag | 2–3d | Login vía proveedor crea/vincula usuario interno y emite JWT; flujo mockeado para tests | docs/AUTHENTICATION.md |

---

Epic: Ledger & Audit (PRIORIDAD: HIGH)
-------------------------------------

| ID | Status | Pri | Title | Estimate | Acceptance Criteria | References |
| --- | --- | --- | --- | ---: | --- | --- |
| LEDGER-001 | pending | high | CI job: export -> sign -> verify (checkpoint verification) | 1–2d | CLI script de verificación; job local ejecutable; verifica firma ECDSA/HMAC; genera informe | docs/ADR_WORLD_LEDGER.md, src/scripts/export_ledger.ts |
| LEDGER-002 | pending | medium | Endpoints/UI admin para anchors (list/download/verify) | 1–2d | Endpoints y UI permiten listar anchors y descargar/verificar | server.ts, docs/ADR_WORLD_LEDGER.md |
| LEDGER-003 | pending | medium | Runbook de gestión de claves y rotación (Vault/KMS guidance) | 0.5d | Procedimiento documentado para rotación y almacenamiento seguro | docs/ADR_WORLD_LEDGER.md |

---

Epic: Persistence & CI Stability (PRIORIDAD: HIGH)
-------------------------------------------------

| ID | Status | Pri | Title | Estimate | Acceptance Criteria | References |
| --- | --- | --- | --- | ---: | --- | --- |
| PERSIST-001 | pending | high | Decidir estrategia CI para better-sqlite3 (instalar deps) o adoptar sql.js en runners | 0.5–1d | Decisión documentada y CI actualizada; tests estables en runner | docs/VALIDATION.md |
| PERSIST-002 | pending | medium | Reemplazar rate-limiter in-memory por Redis opcional (multi-instancia) | 1d | BACKEND toggle disponible; fallback funciona; tests | src/adapters/rateLimit/redisRateLimiter.ts |

---

Epic: AI Task Profiles & Summarization (PRIORIDAD: HIGH → MEDIUM)
----------------------------------------------------------------

| ID | Status | Pri | Title | Estimate | Acceptance Criteria | References |
| --- | --- | --- | --- | ---: | --- | --- |
| AI-001 | pending | high | Implementar AiTaskProfiles (tipos + mapping en adaptadores) | 1d | Core acepta `profile` en llamadas; adaptadores resuelven perfil → modelo/config | docs/AI_TASK_PROFILES.md |
| AI-002 | pending | high | Sustituir truncamiento simple en compactMessages por summarizer semántico | 1–2d | Summarizer reduce tokens y evita errores de longitud de contexto; tests y métricas | server.ts, docs/TASKS.md |
| AI-003 | completed | high | Implementar mapeo personaje → perfil/modelo (per-character AI profile & overrides, API-first) | 1d | Endpoints GET/POST /api/universe/:id/character/:charId/ai-profile implemented and protected; core uses character metadata to set `profile` in AI calls; adapters respect mapping. Referencing server implementation in src/adapters/http/server.ts and domain reconstruction in src/domain/world.ts | docs/AI_TASK_PROFILES.md, prompts/03_FEATURE.md |

---

Epic: UI /play (PRIORIDAD: MEDIUM)
---------------------------------

| ID | Status | Pri | Title | Estimate | Acceptance Criteria | References |
| --- | --- | --- | --- | ---: | --- | --- |
| UI-001 | completed | medium | Corregir bug: checkbox visibility en /play al despublicar | 0.25–0.5d | Owner puede activar/desactivar y cambio persiste; fix: client uses cached owner id fallback to avoid transient hide on unpublish | /play UI, server.ts |
| UI-002 | pending | medium | Modal de detalle de personaje + paginación FILO de eventos | 2–4d | API de paginación; modal muestra últimos 3 eventos y permite "ver más" | docs/FEATURES/interactive_world.md |
| UI-003 | pending | medium | Timelapse/log viewer para ai.request/ai.response/ai.mem_persisted | 1–2d | Playback, filtros y export simple | /play UI |
 
---

Epic: Channels / Worlds Governance (PRIORIDAD: HIGH)
----------------------------------------------------

| ID | Status | Pri | Title | Estimate | Acceptance Criteria | References |
| --- | --- | --- | --- | ---: | --- | --- |
| CHNL-001 | completed | high | Presence API (join/leave/heartbeat) | 1d | Endpoints POST /api/universe/:id/presence and GET /api/universe/:id/presence implemented (in-memory store) and ledger events emitted for join/leave; acceptance: presence reflected and basic persistence of presence events. Further work: Redis-backed presence persistence optional (CHNL-001 follow-up) | docs/FEATURES/CHANNEL_OWNERSHIP.md |
| CHNL-002 | in_progress | high | Claim / reserve owner API | 1d | Minimal POST /api/universe/:id/owner/claim implemented: requires auth and assigns owner when no owner exists (emits owner_assigned); GET /api/universe/:id/owner-status returns current owner. Next: implement reservation/promote/pending flow, TTLs and race-condition tests. | docs/FEATURES/CHANNEL_OWNERSHIP.md |
| CHNL-003 | pending | high | Promotion engine (worker) + locking | 1–2d | Worker evaluates reservations/presence and promotes atomically; uses distributed lock (Redis) when multi-instance; tests simulate concurrency | docs/FEATURES/CHANNEL_OWNERSHIP.md |
| CHNL-004 | pending | medium | Persist reservation + audit events | 0.5d | Reservation record persisted via PersistencePort; owner_reserved/owner_promoted events appended to ledger | docs/FEATURES/CHANNEL_OWNERSHIP.md |
| CHNL-005 | pending | medium | Admin owner override endpoints + RBAC | 0.5d | Admin endpoints POST /api/universe/:id/owner/assign and /revoke documented; protected by API key or admin role; audit events emitted | docs/FEATURES/CHANNEL_OWNERSHIP.md |
| CHNL-006 | pending | medium | E2E tests: create/reserve/promote/transfer | 1–2d | Simulate presence changes and assert reservation/promotions and TTL behavior | docs/FEATURES/CHANNEL_OWNERSHIP.md |
| CHNL-007 | pending | low | Config / feature flags and env defaults | 0.25d | ENV vars documented and tested (dev override to MIN_CONCURRENT=1) | docs/FEATURES/CHANNEL_OWNERSHIP.md |
| CHNL-008 | pending | low | UI consumer: heartbeat integration and owner-status display | 1d | UI consumes presence API and owner-status; purely client-side once API is ready | docs/FEATURES/CHANNEL_OWNERSHIP.md |

---

Epic: Characters & Mobility (PRIORIDAD: HIGH)
-------------------------------------------

| ID | Status | Pri | Title | Estimate | Acceptance Criteria | References |
| --- | --- | --- | --- | ---: | --- | --- |
| CHARS-001 | pending | high | Add character ownership (ownerUserId) persisted in snapshot/events | 0.5d | Character records include ownerUserId when created; snapshots include owner; API returns owner metadata; tests for enforcement when moving characters | docs/FEATURES/CHANNEL_OWNERSHIP.md, src/domain/character.ts |
| CHARS-002 | pending | high | Add character location and move event (location_mundo/worldId) + move endpoint | 1d | Character location stored in snapshot/meta; event `character_moved` emitted on transfers; endpoint POST /api/universe/:id/character/:charId/move{targetUniverseId} with permission checks; tests for transfer and permission | docs/FEATURES/interactive_world.md, docs/FEATURES/CHANNEL_OWNERSHIP.md |
| CHARS-003 | pending | medium | Support invitations/transfers of characters to other worlds with audit | 1d | Owner can invite a character to another world; invitation recorded; accept/decline or direct transfer with consent; audit events emitted | docs/PERMISSIONS.md |


| UI-004 | completed | low | Evitar 401/403 ruidosos en /play cuando no autenticado; manejar errores del proveedor AI devolviendo 502 con diagnóstico | 0.1d | /play ya no muestra missing-credentials en consola; errores AI devuelven {error:'ai_failed'} | src/adapters/http/server.ts |

---

Epic: Tests, QA & Validation (PRIORIDAD: HIGH/MEDIUM)
---------------------------------------------------

| ID | Status | Pri | Title | Estimate | Acceptance Criteria | References |
| --- | --- | --- | --- | ---: | --- | --- |
| QA-001 | pending | high | Añadir mock SMTP en tests e2e para magic-link | 0.5–1d | Tests unit+E2E pasan con mock SMTP | tests/ |
| QA-002 | pending | high | Expandir tests para flows auth (register/login/magic-link/refresh/revoke/OAuth) | 1–2d | Cobertura para casos críticos y rotación/revocación | tests/ |
| QA-003 | pending | medium | Añadir job local de validación (`npm run validate`) documentado y template CI | 0.5d | scripts/validate_change.sh documentado y runnable | docs/VALIDATION.md |

---

Notes
-----

- El Epic Auth está marcado como `in_progress` y la tarea `AUTH-001` ha sido iniciada operacionalmente; si prefieres que todo siga `pending` hasta PRs aprobados, lo dejo así — dime tu preferencia.
- Estrategia de secretos: local-first (.env gitignored), PEM/keys fuera del repo con permisos restringidos. Documentaré la migración a Vault/KMS cuando decidas desplegar.

Próximo paso operativo (ejecución)
---------------------------------

1. Crear una rama local `feature/normalize-tasks-auth` y commitear esta versión canonizada de `docs/TASKS.md`.
2. Empezar a implementar `AUTH-001` (nodemailer send + tests) en una rama separada y abrir PR cuando esté listo.

References
----------

- docs/ROADMAP.md
- docs/AUTHENTICATION.md
- docs/ADR_WORLD_LEDGER.md
- AI_HANDOFF.md
