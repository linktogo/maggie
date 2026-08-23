// English is the source catalog: every other locale is expected to define the
// same keys, and any key missing elsewhere falls back to the value here.
export default {
  'nav.board': 'Board',
  'nav.history': 'History',
  'nav.language': 'Language',

  'notifications.enable': 'enable',
  'notifications.sound': 'sound',
  'notifications.blocked': 'Notifications blocked by the browser.',
  'notification.question': 'An agent is waiting for your input',
  'notification.done': 'Work finished',

  'banner.disconnected': 'disconnected — retrying at the next poll…',
  'banner.ciDesync': 'CI out of sync — {reason}',
  'banner.ciUnavailable': 'CI status unavailable — {reason}',

  'status.todo': 'To do',
  'status.inprogress': 'In progress',
  'status.question': 'Question',
  'status.done': 'Done',

  'summary.repos': 'repos',
  'summary.percentDone': '{percent} % done',

  'filter.searchRepo': '🔍 filter a repo…',
  'filter.techAll': 'tech: all',
  'filter.ciAll': 'CI: all',
  'filter.ciFailure': 'failing',
  'filter.ciOk': 'OK',
  'filter.ciUnknown': 'unknown',

  'card.noActiveSession': 'No active session',
  'card.confirmClose': 'Mark session “{title}” of {repo} as done?',

  'session.untitled': '(untitled)',
  'session.showMore': 'show more',
  'session.showLess': 'show less',
  'session.tokens': '{count} tokens',
  'session.agentTooltip': 'Running on {agent}',
  'session.worktreeTooltip': 'Isolated in git worktree · branch {branch}',
  'session.usageTooltip': 'input {input} · output {output} · cache write {cacheWrite} · cache read {cacheRead}',
  'session.messagePlaceholder': 'Message to the session…',
  'session.send': 'Send',

  'detail.ci': 'Continuous integration',
  'detail.ciUnavailable': 'Unavailable — {reason}',
  'detail.ciEmpty': 'No status reported.',
  'detail.history': 'History',
  'detail.message': 'Message',
  'detail.messageEmpty': 'No message queued.',

  'history.tabPeriod': 'By period',
  'history.tabProject': 'By project',
  'history.modeTokens': 'Tokens',
  'history.day': 'Day',
  'history.week': 'Week',
  'history.month': 'Month',
  'history.year': 'Year',
  'history.empty': 'No completed session yet.',

  'chart.input': 'Input',
  'chart.output': 'Output',
  'chart.cacheWrite': 'Cache write',
  'chart.cacheRead': 'Cache read',
  'chart.cost': 'Cost (€)',
  'chart.unknownModel': 'Unknown model',

  'table.repo': 'Repo',
  'table.title': 'Title',
  'table.started': 'Started',
  'table.ended': 'Ended',
  'table.duration': 'Duration',
  'table.total': 'Total',
  'table.durationMinutes': '{minutes} min',

  'time.secondsAgo': '{n}s ago',
  'time.minutesAgo': '{n} min ago',
  'time.hoursAgo': '{n}h ago',
  'time.daysAgo': '{n}d ago',
};
