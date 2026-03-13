# Day2 Dashboard Manual Validation Checklist (Codex)

## Preconditions
- `npm install` completed
- Backend server running with dashboard static serving:
  - `npm run dev`
- Dashboard available at:
  - `http://127.0.0.1:3000/dashboard`

## Checklist
- [ ] Language toggle appears in top-right (`ZH` / `EN`).
- [ ] Toggle to `EN`, refresh page, language remains English.
- [ ] Toggle to `ZH`, refresh page, language remains Chinese.
- [ ] Overview key labels switch language (metrics, tabs, leaderboard/task/event labels).
- [ ] Agent Competition page labels switch language (banner, graph, publish form, status columns, results).

- [ ] In Agent Competition, scenario selector shows 3 options:
  - Balanced Competition
  - One Dominant Agent
  - High-Frequency Task Storm
- [ ] Click `Load Scenario` and verify mode badge switches to scenario mode.
- [ ] Click `Play/Pause` and verify task statuses/responses stop/resume changing.
- [ ] Click `Step` and verify a single progression tick occurs.
- [ ] Adjust `Speed` slider and verify progression cadence changes.
- [ ] Click `Return Live` and verify view returns to live/mock stream mode.

- [ ] Competition graph shows readable flow/agent node separation and visible legend.
- [ ] Active data flow animation is visible and smooth (moving highlighted link band).
- [ ] Graph remains usable/responsive on narrow viewport (mobile width).

- [ ] Existing publish task form still works and appends a new task card.
- [ ] Existing overview data panels still render and update.
- [ ] WebSocket connect/disconnect controls remain functional.

## Required Command Checks
- [ ] `npm run dashboard:build`
- [ ] `npm test`
