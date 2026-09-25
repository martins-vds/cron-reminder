# Product Roadmap

Cron Reminder already provides flexible recurring schedules, cross-device
synchronization, offline support, push notifications, history, backups,
localization, and manual conflict resolution. The next releases should focus
on making those capabilities easier to use in everyday workflows before
expanding into collaboration and platform-specific features.

## Recommended Next Release

### 1. Today and Upcoming

Add an agenda that combines calculated occurrences across reminders and groups
them into Overdue, Today, Tomorrow, and Later.

The agenda should:

- Show the next occurrence and originating reminder.
- Provide dismiss and snooze actions without opening the reminder editor.
- Refresh after synchronization or an occurrence action.
- Clearly distinguish missed, postponed, and upcoming occurrences.

This is the highest-priority feature because it turns the existing scheduling
and history infrastructure into a daily command center.

### 2. Quick Add and Native Schedule Controls

Replace manual ISO timestamps and numeric schedule fields with platform-native
date and time controls. Add a lightweight quick-add flow for common reminders,
while retaining the full editor for advanced schedules.

### 3. Reminder Templates

Provide reusable templates for common scenarios such as medication, bills,
chores, meetings, reports, and recurring maintenance. Users should also be able
to save an existing reminder as a personal template.

## Prioritized Backlog

| Priority | Feature | User value | Estimated effort |
| --- | --- | --- | --- |
| 1 | Today and Upcoming agenda | Makes the application useful as a daily command center | Medium |
| 2 | Quick add with native date and time controls | Removes schedule-entry friction and avoids manual ISO timestamps | Small–Medium |
| 3 | Schedule exceptions | Supports skipped dates, weekends, vacations, and holidays | Medium |
| 4 | Custom snooze and escalation | Adds user-defined snooze durations and repeat-until-acknowledged behavior | Medium |
| 5 | Reminder templates | Speeds up creation of common and repeated reminder patterns | Small |
| 6 | Device management | Lets users inspect registered devices and remotely disable notifications | Medium |
| 7 | Calendar integration | Imports and exports ICS data and creates reminders from calendar events | Medium–Large |
| 8 | History insights | Shows delivery reliability, missed reminders, response time, and tag trends | Medium |
| 9 | Shared reminders | Supports family or team assignments with synchronized activity | Large |
| 10 | Home-screen widgets and shortcuts | Surfaces upcoming reminders and provides a quick-reminder action | Large |
| 11 | Location-based reminders | Triggers reminders when arriving at or leaving a location | Large |
| 12 | Natural-language scheduling | Converts phrases such as “every other Friday at 4” into reviewable schedules | Medium–Large |

## Later Releases

### Scheduling and Notification Controls

- Add one-off exclusion dates to recurring schedules.
- Support holiday calendars and vacation pauses.
- Allow per-reminder snooze presets.
- Add escalation policies and optional repeated delivery until acknowledgment.
- Let users configure quiet hours and notification behavior by device.

### Account and Device Management

- List registered devices with platform and last activity.
- Allow remote notification deregistration.
- Surface notification delivery failures and corrective guidance.

### Integrations and Insights

- Import and export calendars using ICS.
- Create reminders from calendar events.
- Summarize notification delivery reliability.
- Report missed and acknowledged occurrences by reminder or tag.
- Show typical acknowledgment time without exposing notification credentials.

### Collaboration

Shared reminders should follow after the single-user experience is mature.
This work will require membership and assignment models, revised Row Level
Security policies, invitation flows, notification routing, conflict behavior,
and an activity audit trail.

### Platform Enhancements

- Add Android and iOS widgets.
- Add operating-system quick actions.
- Evaluate geofencing for location reminders, including background execution,
  battery use, permissions, and platform delivery limitations.
- Add natural-language schedule parsing with an explicit preview and
  confirmation step before saving.

## Sequencing Principles

1. Prefer features that reuse the existing domain, occurrence, history, and
   notification infrastructure.
2. Improve schedule creation and daily visibility before adding new schedule
   types.
3. Keep advanced cron functionality available without making it the default
   interaction.
4. Introduce collaboration only after ownership, privacy, synchronization, and
   notification behavior are clearly defined.
5. Treat location triggers, widgets, and background execution as separate
   platform projects with native validation.
