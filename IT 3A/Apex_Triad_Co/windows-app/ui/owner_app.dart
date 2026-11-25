import 'package:flutter/material.dart';
import '../core/outbox.dart';
import '../core/money.dart';
import '../core/pending_sales.dart';
import '../data/owner_controller.dart';
import 'terminal_panel.dart';

const gold = Color(0xFFD8B56A);
String money(dynamic amount) =>
    '₱${((amount as num? ?? 0) / 100).toStringAsFixed(2)}';
DateTime get phtNow => DateTime.now().toUtc().add(const Duration(hours: 8));
String day(DateTime date) => date.toIso8601String().substring(0, 10);
String hours(Json booking) =>
    '${booking['startHour']}:00–${booking['endHour']}:00';

class ClinchApp extends StatefulWidget {
  const ClinchApp({super.key, required this.controller});
  final OwnerController controller;
  @override
  State<ClinchApp> createState() => _ClinchAppState();
}

class _ClinchAppState extends State<ClinchApp> with WidgetsBindingObserver {
  final _navigator = GlobalKey<NavigatorState>();
  bool _hadAccess = false;
  void _accessChanged() {
    final accessible = widget.controller.accessible;
    if (_hadAccess && !accessible) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _navigator.currentState?.popUntil((route) => route.isFirst);
      });
    }
    _hadAccess = accessible;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_accessChanged);
    widget.controller.initialize();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) widget.controller.enforceAccess();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_accessChanged);
    widget.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
      title: 'Clinch · Owner',
      debugShowCheckedModeBanner: false,
      navigatorKey: _navigator,
      theme: ThemeData(
          useMaterial3: true,
          brightness: Brightness.dark,
          colorScheme: ColorScheme.fromSeed(
              seedColor: gold,
              brightness: Brightness.dark,
              primary: gold,
              surface: const Color(0xFF171717)),
          scaffoldBackgroundColor: const Color(0xFF101010),
          cardTheme: const CardThemeData(
              elevation: 0,
              color: Color(0xFF1C1C1C),
              margin: EdgeInsets.zero,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.all(Radius.circular(18)))),
          inputDecorationTheme: InputDecorationTheme(
              filled: true,
              fillColor: const Color(0xFF242424),
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide.none)),
          filledButtonTheme: FilledButtonThemeData(
              style: FilledButton.styleFrom(
                  minimumSize: const Size(48, 48),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)))),
          appBarTheme: const AppBarTheme(
              backgroundColor: Color(0xFF101010), scrolledUnderElevation: 0)),
      home: AnimatedBuilder(
          animation: widget.controller,
          builder: (context, _) {
            final c = widget.controller;
            if (c.fatal != null) {
              return Scaffold(
                  body: Center(
                      child: Padding(
                          padding: const EdgeInsets.all(32),
                          child: ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 600),
                              child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    const Icon(Icons.lock_outline,
                                        size: 56, color: gold),
                                    const SizedBox(height: 24),
                                    const Text('Your local files are preserved',
                                        style: TextStyle(fontSize: 24)),
                                    const SizedBox(height: 16),
                                    SelectableText(c.fatal!),
                                    const SizedBox(height: 16),
                                    Text(
                                        'Close the app, restore the original server configuration or OS secure storage, then reopen it.')
                                  ])))));
            }
            if (!c.ready) {
              return const Scaffold(
                  body: Center(child: CircularProgressIndicator()));
            }
            return c.accessible
                ? OwnerShell(controller: c)
                : LoginScreen(controller: c);
          }));
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.controller});
  final OwnerController controller;
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final email = TextEditingController(), password = TextEditingController();
  @override
  void dispose() {
    email.dispose();
    password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return Scaffold(
        body: SafeArea(
            child: Center(
                child: SingleChildScrollView(
                    padding: const EdgeInsets.all(28),
                    child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 440),
                        child: AutofillGroup(
                            child: Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                              const Icon(Icons.auto_stories_outlined,
                                  color: gold, size: 48),
                              const SizedBox(height: 18),
                              const Text('CLINCH',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(
                                      fontWeight: FontWeight.w800,
                                      fontSize: 38,
                                      letterSpacing: 8)),
                              const Text('STUDY HUB  /  OWNER',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(
                                      color: gold,
                                      letterSpacing: 3,
                                      fontSize: 11)),
                              const SizedBox(height: 48),
                              Text(
                                  c.pendingCount == 0
                                      ? 'Make room for focus.'
                                      : 'Welcome back, Owner.',
                                  style: const TextStyle(
                                      fontSize: 28,
                                      fontWeight: FontWeight.w600)),
                              const SizedBox(height: 10),
                              Text(
                                  c.pendingCount == 0
                                      ? 'Sign in online to connect your owner workspace. An encrypted cache keeps the essentials available for up to eight hours.'
                                      : '${c.pendingCount} queued changes are safe on this device. Sign in online as the same owner to recover and synchronize them.',
                                  style: const TextStyle(
                                      color: Colors.white60, height: 1.5)),
                              const SizedBox(height: 28),
                              TextField(
                                  controller: email,
                                  keyboardType: TextInputType.emailAddress,
                                  autofillHints: const [
                                    AutofillHints.username,
                                    AutofillHints.email
                                  ],
                                  autocorrect: false,
                                  enableSuggestions: false,
                                  textInputAction: TextInputAction.next,
                                  decoration: const InputDecoration(
                                      labelText: 'Owner email',
                                      prefixIcon: Icon(Icons.person_outline))),
                              const SizedBox(height: 14),
                              TextField(
                                  controller: password,
                                  obscureText: true,
                                  autofillHints: const [AutofillHints.password],
                                  onSubmitted: (_) => _login(),
                                  decoration: const InputDecoration(
                                      labelText: 'Password',
                                      prefixIcon: Icon(Icons.lock_outline))),
                              if (c.error != null)
                                Padding(
                                    padding: const EdgeInsets.symmetric(
                                        vertical: 14),
                                    child: Text(c.error!,
                                        style: const TextStyle(
                                            color: Colors.orangeAccent))),
                              const SizedBox(height: 22),
                              FilledButton(
                                  onPressed: c.busy ? null : _login,
                                  child: Text(c.busy
                                      ? 'Connecting…'
                                      : 'Open owner workspace')),
                              const SizedBox(height: 16),
                              Text(c.api.baseUrl,
                                  textAlign: TextAlign.center,
                                  style: const TextStyle(
                                      color: Colors.white38, fontSize: 11)),
                            ])))))));
  }

  Future<void> _login() async {
    final signedIn = await widget.controller
        .run(() => widget.controller.login(email.text.trim(), password.text));
    if (mounted && signedIn) password.clear();
  }
}

class OwnerShell extends StatefulWidget {
  const OwnerShell({super.key, required this.controller});
  final OwnerController controller;
  @override
  State<OwnerShell> createState() => _OwnerShellState();
}

class _OwnerShellState extends State<OwnerShell> {
  int page = 0;
  static const labels = [
    'Overview',
    'Reservations',
    'Cash desk',
    'Sync center',
    'Workspace'
  ];
  static const icons = [
    Icons.grid_view_rounded,
    Icons.event_seat_outlined,
    Icons.point_of_sale_outlined,
    Icons.sync,
    Icons.workspaces_outline
  ];
  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final wide = MediaQuery.sizeOf(context).width >= 850;
    final views = [
      Dashboard(c: c, openBookings: () => setState(() => page = 1)),
      Reservations(c: c),
      CashDesk(c: c),
      SyncCenter(c: c),
      Workspace(c: c)
    ];
    return Scaffold(
        appBar: AppBar(
            title: const Text('CLINCH',
                style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 5)),
            actions: [
              Padding(
                  padding: const EdgeInsets.only(right: 16),
                  child: Chip(
                      avatar: Icon(
                          c.online
                              ? Icons.cloud_done_outlined
                              : Icons.cloud_off_outlined,
                          size: 17,
                          color: gold),
                      label: Text(
                          c.online ? 'API connected' : 'Cached workspace',
                          style: const TextStyle(fontSize: 11))))
            ]),
        body: SafeArea(
            child: Row(children: [
          if (wide)
            NavigationRail(
                selectedIndex: page,
                extended: MediaQuery.sizeOf(context).width > 1200,
                onDestinationSelected: (value) => setState(() => page = value),
                destinations: List.generate(
                    labels.length,
                    (index) => NavigationRailDestination(
                        icon: Icon(icons[index]), label: Text(labels[index])))),
          Expanded(
              child: Column(children: [
            if (c.busy) const LinearProgressIndicator(minHeight: 2),
            if (c.error != null)
              Material(
                  color: const Color(0xFF47351C),
                  child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Row(children: [
                        const Icon(Icons.info_outline, size: 20),
                        const SizedBox(width: 10),
                        Expanded(
                            child: Text(c.error!,
                                style: const TextStyle(fontSize: 12))),
                        IconButton(
                            tooltip: 'Dismiss message',
                            icon: const Icon(Icons.close, size: 18),
                            onPressed: () => setState(() => c.error = null))
                      ]))),
            Expanded(
                child: Center(
                    child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 1280),
                        child: views[page]))),
          ])),
        ])),
        bottomNavigationBar: wide
            ? null
            : NavigationBar(
                selectedIndex: page,
                onDestinationSelected: (value) => setState(() => page = value),
                labelBehavior:
                    NavigationDestinationLabelBehavior.onlyShowSelected,
                destinations: List.generate(
                    labels.length,
                    (index) => NavigationDestination(
                        icon: Icon(icons[index]), label: labels[index]))));
  }
}

class PageBody extends StatelessWidget {
  const PageBody(
      {super.key,
      required this.title,
      required this.subtitle,
      required this.children,
      this.action});
  final String title, subtitle;
  final List<Widget> children;
  final Widget? action;
  @override
  Widget build(BuildContext context) => ListView(
          padding:
              EdgeInsets.all(MediaQuery.sizeOf(context).width < 600 ? 20 : 32),
          children: [
            Text(title,
                style:
                    const TextStyle(fontSize: 29, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(subtitle,
                style: const TextStyle(color: Colors.white54, height: 1.5)),
            if (action != null)
              Align(
                  alignment: Alignment.centerLeft,
                  child: Padding(
                      padding: const EdgeInsets.only(top: 20), child: action!)),
            const SizedBox(height: 24),
            ...children
          ]);
}

class Dashboard extends StatelessWidget {
  const Dashboard({super.key, required this.c, required this.openBookings});
  final OwnerController c;
  final VoidCallback openBookings;
  @override
  Widget build(BuildContext context) {
    final today = c
        .records('bookings')
        .where((b) => b['date'] == day(phtNow) && b['status'] != 'cancelled')
        .toList();
    final occupied = today.where((b) => b['status'] == 'checked_in').length;
    final sales = c.records('sales').where((s) =>
        day(DateTime.parse(s['createdAt'] as String)
            .toUtc()
            .add(const Duration(hours: 8))) ==
        day(phtNow));
    final revenue = sales.fold<int>(0, (sum, s) => sum + (s['total'] as int));
    return PageBody(
        title: 'A space for great days.',
        subtitle:
            'Welcome, ${c.snapshot['user']?['name'] ?? 'Owner'}. Here is your hub today · ${day(phtNow)} PHT',
        action: OutlinedButton.icon(
            onPressed: c.busy ? null : () => c.run(c.synchronize),
            icon: const Icon(Icons.refresh),
            label: Text('Refresh & sync')),
        children: [
          LayoutBuilder(
              builder: (context, box) =>
                  Wrap(spacing: 14, runSpacing: 14, children: [
                    _metric('TODAY’S COLLECTIONS', money(revenue),
                        Icons.payments_outlined, box.maxWidth),
                    _metric('RESERVATIONS', '${today.length}',
                        Icons.event_outlined, box.maxWidth),
                    _metric(
                        'CHECKED IN',
                        '$occupied / ${c.records('resources').length}',
                        Icons.chair_outlined,
                        box.maxWidth),
                    _metric('LOCAL PENDING', '${c.pendingCount}',
                        Icons.cloud_upload_outlined, box.maxWidth),
                  ])),
          const SizedBox(height: 28),
          Card(
              child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Your hub, at a glance',
                            style: TextStyle(
                                fontSize: 20, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 12),
                        Text(
                            'Gold spaces are checked in. Cached reservations remain separate from local pending changes.',
                            style: const TextStyle(
                                color: Colors.white54, height: 1.5)),
                        const SizedBox(height: 22),
                        Wrap(
                            spacing: 10,
                            runSpacing: 10,
                            children: c.records('resources').map((resource) {
                              final used = today.any((b) =>
                                  b['resourceId'] == resource['id'] &&
                                  b['status'] == 'checked_in');
                              return Container(
                                  width: resource['type'] == 'room' ? 130 : 64,
                                  padding:
                                      const EdgeInsets.symmetric(vertical: 18),
                                  decoration: BoxDecoration(
                                      color:
                                          used ? gold : const Color(0xFF282828),
                                      borderRadius: BorderRadius.circular(12)),
                                  child: Text(resource['name'] as String,
                                      textAlign: TextAlign.center,
                                      style: TextStyle(
                                          color: used
                                              ? Colors.black
                                              : Colors.white70,
                                          fontWeight: FontWeight.w600)));
                            }).toList()),
                        const SizedBox(height: 16),
                        TextButton(
                            onPressed: openBookings,
                            child: const Text('Manage reservations →')),
                      ]))),
          const SizedBox(height: 24),
          Text('RECENT TRANSACTIONS',
              style:
                  const TextStyle(color: gold, letterSpacing: 2, fontSize: 11)),
          const SizedBox(height: 12),
          if (c.records('sales').isEmpty)
            EmptyState(
                text: 'Collections will appear here after a cash checkout.'),
          ...c.records('sales').take(5).map((s) => Card(
              child: ListTile(
                  leading: const Icon(Icons.receipt_long_outlined, color: gold),
                  title: Text(s['reference'] as String),
                  subtitle: Text(s['createdAt'].toString()),
                  trailing: Text(money(s['total'])),
                  onTap: () => receiptDialog(context, s)))),
        ]);
  }

  Widget _metric(String label, String value, IconData icon, double width) =>
      SizedBox(
          width: width >= 800 ? (width - 42) / 4 : (width - 14) / 2,
          child: Card(
              child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(icon, color: gold, size: 23),
                        const SizedBox(height: 20),
                        FittedBox(
                            child: Text(value,
                                style: const TextStyle(
                                    fontSize: 26,
                                    fontWeight: FontWeight.w600))),
                        const SizedBox(height: 7),
                        Text(label,
                            style: const TextStyle(
                                fontSize: 9,
                                color: Colors.white54,
                                letterSpacing: 1.1)),
                      ]))));
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 30),
      child: Text(text,
          textAlign: TextAlign.center,
          style: const TextStyle(color: Colors.white54, height: 1.5)));
}

class Reservations extends StatefulWidget {
  const Reservations({super.key, required this.c});
  final OwnerController c;
  @override
  State<Reservations> createState() => _ReservationsState();
}

class _ReservationsState extends State<Reservations> {
  String selected = day(phtNow);
  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final list = c
        .records('bookings')
        .where((b) => b['date'] == selected)
        .toList()
      ..sort(
          (a, b) => (a['startHour'] as int).compareTo(b['startHour'] as int));
    return PageBody(
        title: 'Reservations',
        subtitle:
            'Check in your guests and keep the day flowing. Status changes require the API.',
        action: Wrap(spacing: 12, runSpacing: 12, children: [
          FilledButton.icon(
              onPressed: c.busy ? null : () => bookingDialog(context, c),
              icon: const Icon(Icons.add),
              label: Text('Walk-in booking')),
          OutlinedButton.icon(
              onPressed: () async {
                final date = await showDatePicker(
                    context: context,
                    initialDate: DateTime.parse(selected),
                    firstDate: DateTime(2020),
                    lastDate: DateTime(2100));
                if (date != null) setState(() => selected = day(date));
              },
              icon: const Icon(Icons.calendar_today_outlined),
              label: Text(selected))
        ]),
        children: [
          if (list.isEmpty)
            EmptyState(text: 'No confirmed server reservations on this date.'),
          ...list.map((b) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Card(
                  child: Padding(
                      padding: const EdgeInsets.all(18),
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(children: [
                              Expanded(
                                  child: Text(b['customerName'] as String,
                                      style: const TextStyle(
                                          fontSize: 18,
                                          fontWeight: FontWeight.w600))),
                              Text(money(b['total']),
                                  style: const TextStyle(color: gold))
                            ]),
                            const SizedBox(height: 8),
                            Text(
                                '${b['reference']} · ${b['resourceId']} · ${hours(b)}',
                                style: const TextStyle(color: Colors.white54)),
                            const SizedBox(height: 12),
                            Wrap(spacing: 8, runSpacing: 8, children: [
                              Chip(
                                  label: Text(
                                      b['status'].toString().replaceAll('_', ' '))),
                              Chip(
                                  label: Text(
                                      b['paid'] == true ? 'Paid' : 'Unpaid')),
                              if (b['status'] == 'confirmed')
                                TextButton(
                                    onPressed: c.busy || !c.online
                                        ? null
                                        : () => c.run(() =>
                                            c.changeStatus(b, 'checked_in')),
                                    child: const Text('Check in')),
                              if (b['status'] == 'checked_in')
                                TextButton(
                                    onPressed: c.busy || !c.online
                                        ? null
                                        : () => c.run(() =>
                                            c.changeStatus(b, 'completed')),
                                    child: const Text('Complete')),
                              if (b['status'] == 'confirmed')
                                TextButton(
                                    onPressed: c.busy || !c.online
                                        ? null
                                        : () async {
                                            if (await confirm(
                                                context,
                                                'Cancel reservation?',
                                                '${b['reference']} will be cancelled on the server.')) {
                                              await c.run(() => c.changeStatus(
                                                  b, 'cancelled'));
                                            }
                                          },
                                    child: const Text('Cancel'))
                            ]),
                          ]))))),
          if (c.pending.where((op) => op['type'] == 'booking').isNotEmpty) ...[
            const SizedBox(height: 20),
            Text('LOCAL PENDING · NOT CONFIRMED',
                style: const TextStyle(
                    color: gold, letterSpacing: 1.5, fontSize: 11)),
            const SizedBox(height: 10),
            ...c.pending.where((op) => op['type'] == 'booking').map((op) =>
                ListTile(
                    leading: const Icon(Icons.schedule, color: gold),
                    title: Text(
                        '${op['payload']['customerName']} · ${op['payload']['resourceId']}'),
                    subtitle:
                        Text('${op['payload']['date']} · ${op['status']}'))),
          ]
        ]);
  }
}

Future<void> bookingDialog(BuildContext context, OwnerController c,
    {Json? draft}) async {
  final name =
      TextEditingController(text: draft?['customerName'] as String? ?? '');
  final resources = c.records('resources');
  if (resources.isEmpty) {
    name.dispose();
    return;
  }
  var resource =
      (draft?['resourceId'] as String?) ?? resources.first['id'] as String;
  var date = draft?['date'] as String? ?? day(phtNow);
  var start = draft?['startHour'] as int? ?? 8,
      end = draft?['endHour'] as int? ?? 9;
  String? validation;
  await showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
          builder: (context, update) => AlertDialog(
                  title: Text(draft == null
                      ? 'Welcome a walk-in'
                      : 'Edit as a new booking'),
                  content: SizedBox(
                      width: 420,
                      child: SingleChildScrollView(
                          child: Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                            Text(
                                'Saved locally first. Availability and final total are confirmed by the server.',
                                style: const TextStyle(
                                    color: Colors.white54, height: 1.5)),
                            const SizedBox(height: 20),
                            TextField(
                                controller: name,
                                maxLength: 100,
                                decoration: const InputDecoration(
                                    labelText: 'Guest name')),
                            const SizedBox(height: 14),
                            DropdownButtonFormField<String>(
                                initialValue: resource,
                                decoration: const InputDecoration(
                                    labelText: 'Seat or room'),
                                items: resources
                                    .map((r) => DropdownMenuItem(
                                        value: r['id'] as String,
                                        child: Text(
                                            '${r['name']} · ${money(r['rate'])}/hr')))
                                    .toList(),
                                onChanged: (value) =>
                                    update(() => resource = value!)),
                            const SizedBox(height: 14),
                            OutlinedButton.icon(
                                onPressed: () async {
                                  final value = await showDatePicker(
                                      context: context,
                                      initialDate: DateTime.parse(date)
                                              .isBefore(
                                                  DateTime.parse(day(phtNow)))
                                          ? DateTime.parse(day(phtNow))
                                          : DateTime.parse(date),
                                      firstDate: DateTime.parse(day(phtNow)),
                                      lastDate: DateTime.now()
                                          .add(const Duration(days: 365)));
                                  if (value != null) {
                                    update(() => date = day(value));
                                  }
                                },
                                icon: const Icon(Icons.calendar_today_outlined),
                                label: Text('$date · PHT')),
                            const SizedBox(height: 14),
                            Row(children: [
                              Expanded(
                                  child: DropdownButtonFormField<int>(
                                      initialValue: start,
                                      decoration: const InputDecoration(
                                          labelText: 'From'),
                                      items: List.generate(
                                          14,
                                          (i) => DropdownMenuItem(
                                              value: i + 8,
                                              child: Text('${i + 8}:00'))),
                                      onChanged: (value) => update(() {
                                            start = value!;
                                            if (end <= start) end = start + 1;
                                          }))),
                              const SizedBox(width: 12),
                              Expanded(
                                  child: DropdownButtonFormField<int>(
                                      key: ValueKey(end),
                                      initialValue: end,
                                      decoration: const InputDecoration(
                                          labelText: 'Until'),
                                      items: List.generate(
                                          14,
                                          (i) => DropdownMenuItem(
                                              value: i + 9,
                                              child: Text('${i + 9}:00'))),
                                      onChanged: (value) =>
                                          update(() => end = value!)))
                            ]),
                            const SizedBox(height: 18),
                            Text(
                                'Estimate: ${money((resources.firstWhere((r) => r['id'] == resource)['rate'] as int) * (end - start))}',
                                style:
                                    const TextStyle(color: gold, fontSize: 20)),
                            if (validation != null)
                              Padding(
                                  padding: const EdgeInsets.only(top: 12),
                                  child: Text(validation!,
                                      style: const TextStyle(
                                          color: Colors.orangeAccent))),
                          ]))),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(context),
                        child: const Text('Back')),
                    FilledButton(
                        onPressed: c.busy
                            ? null
                            : () async {
                                if (name.text.trim().isEmpty || end <= start) {
                                  update(() => validation =
                                      'Enter a guest name and at least one hour.');
                                  return;
                                }
                                final payload = <String, dynamic>{
                                  'customerName': name.text.trim(),
                                  'resourceId': resource,
                                  'date': date,
                                  'startHour': start,
                                  'endHour': end
                                };
                                final ok = await c
                                    .run(() => c.submit('booking', payload));
                                if (!context.mounted) return;
                                if (ok) {
                                  Navigator.pop(context);
                                } else {
                                  update(() => validation =
                                      c.error ?? 'Could not save booking.');
                                }
                              },
                        child: Text('Save booking'))
                  ])));
  name.dispose();
}

class CashDesk extends StatefulWidget {
  const CashDesk({super.key, required this.c});
  final OwnerController c;
  @override
  State<CashDesk> createState() => _CashDeskState();
}

class _CashDeskState extends State<CashDesk> {
  final cart = <String, int>{};
  final tender = TextEditingController();
  String? bookingId, validation;
  @override
  void dispose() {
    tender.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c, products = widget.c.records('products');
    final pendingSales = PendingSales(c.pending);
    final settledPending = pendingSales.bookingIds;
    final bookings = c
        .records('bookings')
        .where((b) =>
            b['paid'] != true &&
            b['status'] != 'cancelled' &&
            !settledPending.contains(b['id']))
        .toList();
    if (!bookings.any((b) => b['id'] == bookingId)) bookingId = null;
    final booking = bookings.where((b) => b['id'] == bookingId).firstOrNull;
    final subtotal = cart.entries.fold<int>(
        0,
        (sum, item) =>
            sum +
            (products.firstWhere((p) => p['id'] == item.key)['price'] as int) *
                item.value);
    final total = subtotal + (booking?['total'] as int? ?? 0);
    return PageBody(
        title: 'Cash desk',
        subtitle:
            'A good coffee. A little focus. One simple checkout. Amounts are PHP; cash only.',
        children: [
          LayoutBuilder(builder: (context, box) {
            final catalog =
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('THE LITTLE EXTRAS',
                  style:
                      TextStyle(color: gold, letterSpacing: 2, fontSize: 11)),
              const SizedBox(height: 16),
              Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: products.map((product) {
                    final id = product['id'] as String;
                    final remaining = (product['stock'] as int) -
                        (pendingSales.quantities[id] ?? 0);
                    final quantity = cart[id] ?? 0;
                    return SizedBox(
                        width:
                            box.maxWidth < 550 ? (box.maxWidth - 12) / 2 : 175,
                        child: Card(
                            child: Padding(
                                padding: const EdgeInsets.all(16),
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Icon(
                                          product['category'] == 'stationery'
                                              ? Icons.edit_note
                                              : Icons.local_cafe_outlined,
                                          color: gold,
                                          size: 30),
                                      const SizedBox(height: 20),
                                      Text(product['name'] as String,
                                          style: const TextStyle(
                                              fontWeight: FontWeight.w600)),
                                      const SizedBox(height: 8),
                                      Text(money(product['price']),
                                          style: const TextStyle(color: gold)),
                                      Text('$remaining in cached stock',
                                          style: const TextStyle(
                                              color: Colors.white38,
                                              fontSize: 10)),
                                      Row(
                                          mainAxisAlignment:
                                              MainAxisAlignment.spaceBetween,
                                          children: [
                                            IconButton(
                                                tooltip: 'Remove one',
                                                onPressed: quantity == 0 ||
                                                        c.busy
                                                    ? null
                                                    : () => setState(() {
                                                          if (quantity == 1) {
                                                            cart.remove(id);
                                                          } else {
                                                            cart[id] =
                                                                quantity - 1;
                                                          }
                                                        }),
                                                icon: const Icon(Icons.remove,
                                                    size: 17)),
                                            Text('$quantity'),
                                            IconButton(
                                                tooltip: 'Add one',
                                                onPressed:
                                                    quantity >= remaining ||
                                                            c.busy
                                                        ? null
                                                        : () => setState(() =>
                                                            cart[id] =
                                                                quantity + 1),
                                                icon: const Icon(Icons.add,
                                                    size: 17))
                                          ]),
                                    ]))));
                  }).toList()),
            ]);
            final checkout = Card(
                child: Padding(
                    padding: const EdgeInsets.all(22),
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const Text('Your order',
                              style: TextStyle(
                                  fontSize: 23, fontWeight: FontWeight.w600)),
                          const SizedBox(height: 20),
                          DropdownButtonFormField<String>(
                              key: ValueKey(bookingId),
                              initialValue: bookingId ?? '',
                              isExpanded: true,
                              decoration: InputDecoration(
                                  labelText: 'Collect reservation payment'),
                              items: [
                                const DropdownMenuItem(
                                    value: '', child: Text('Products only')),
                                ...bookings.map((b) => DropdownMenuItem(
                                    value: b['id'] as String,
                                    child: Text(
                                        '${b['reference']} · ${b['customerName']}',
                                        overflow: TextOverflow.ellipsis)))
                              ],
                              onChanged: c.busy
                                  ? null
                                  : (value) => setState(() =>
                                      bookingId = value == '' ? null : value)),
                          const SizedBox(height: 22),
                          ...cart.entries.map((item) => Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: Row(children: [
                                Expanded(
                                    child: Text(
                                        '${item.value} × ${products.firstWhere((p) => p['id'] == item.key)['name']}')),
                                Text(money((products.firstWhere(
                                            (p) => p['id'] == item.key)['price']
                                        as int) *
                                    item.value))
                              ]))),
                          if (booking != null)
                            Row(children: [
                              const Expanded(child: Text('Reservation')),
                              Text(money(booking['total']))
                            ]),
                          const Divider(height: 32),
                          Row(children: [
                            const Expanded(child: Text('Estimated total')),
                            Text(money(total),
                                style:
                                    const TextStyle(fontSize: 25, color: gold))
                          ]),
                          const SizedBox(height: 18),
                          TextField(
                              controller: tender,
                              keyboardType:
                                  const TextInputType.numberWithOptions(
                                      decimal: true),
                              onChanged: (_) => setState(() {}),
                              decoration: InputDecoration(
                                  labelText: 'Cash received',
                                  prefixText: '₱ ')),
                          const SizedBox(height: 12),
                          Text(
                              'Estimated change: ${money((centavos(tender.text) ?? 0) - total)}',
                              style: const TextStyle(color: Colors.white54)),
                          const SizedBox(height: 18),
                          Text(
                              'The server confirms totals and stock. Offline cash sales remain pending; no official receipt is issued until accepted.',
                              style: const TextStyle(
                                  fontSize: 11,
                                  color: Colors.white54,
                                  height: 1.6)),
                          if (validation != null)
                            Padding(
                                padding: const EdgeInsets.only(top: 12),
                                child: Text(validation!,
                                    style: const TextStyle(
                                        color: Colors.orangeAccent))),
                          const SizedBox(height: 20),
                          FilledButton.icon(
                              onPressed: c.busy || total <= 0
                                  ? null
                                  : () async {
                                      final paid = centavos(tender.text);
                                      if (paid == null || paid < total) {
                                        setState(() => validation =
                                            'Enter enough cash, with at most two decimal places.');
                                        return;
                                      }
                                      final payload = <String, dynamic>{
                                        'items': cart.entries
                                            .map((item) => {
                                                  'productId': item.key,
                                                  'quantity': item.value
                                                })
                                            .toList(),
                                        if (booking != null)
                                          'bookingId': booking['id'],
                                        if (booking != null)
                                          'bookingVersion': booking['version'],
                                        'method': 'cash',
                                        'tendered': paid
                                      };
                                      c.lastReceipt = null;
                                      final ok = await c
                                          .run(() => c.submit('sale', payload));
                                      if (ok && context.mounted) {
                                        setState(() {
                                          cart.clear();
                                          bookingId = null;
                                          tender.clear();
                                          validation = null;
                                        });
                                        if (c.lastReceipt != null) {
                                          await receiptDialog(
                                              context, c.lastReceipt!);
                                        } else if (context.mounted) {
                                          ScaffoldMessenger.of(context)
                                              .showSnackBar(SnackBar(
                                                  content: Text(
                                                      'Saved in encrypted queue. Review its status in Sync center.')));
                                        }
                                      }
                                    },
                              icon: const Icon(Icons.payments_outlined),
                              label: Text('Record cash checkout')),
                        ])));
            if (box.maxWidth >= 900) {
              return Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: catalog),
                    const SizedBox(width: 24),
                    SizedBox(width: 340, child: checkout)
                  ]);
            }
            return Column(
                children: [catalog, const SizedBox(height: 24), checkout]);
          }),
        ]);
  }
}

class SyncCenter extends StatelessWidget {
  const SyncCenter({super.key, required this.c});
  final OwnerController c;
  @override
  Widget build(BuildContext context) => PageBody(
          title: 'Continuity, built in.',
          subtitle:
              'Your encrypted local queue keeps each original operation ID through retries. Conflicts remain here until you review them.',
          action: FilledButton.icon(
              onPressed: c.busy ? null : () => c.run(c.synchronize),
              icon: const Icon(Icons.sync),
              label: Text('Reach API & sync next 50')),
          children: [
            Card(
                child: Padding(
                    padding: const EdgeInsets.all(22),
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                              c.online
                                  ? 'API is reachable'
                                  : 'Working from the encrypted cache',
                              style:
                                  const TextStyle(color: gold, fontSize: 20)),
                          const SizedBox(height: 10),
                          Text(
                              'Last completed sync: ${c.lastSync ?? 'Not yet in this session'}\nCached owner access ends: ${c.leaseExpiry?.toLocal()}\nAutomatic reachability check: every 45 seconds, one batch per attempt.',
                              style: const TextStyle(
                                  color: Colors.white54, height: 1.7)),
                        ]))),
            const SizedBox(height: 24),
            if (c.terminal != null) TerminalPanel(controller: c),
            if (c.pendingCount == 0)
              const EmptyState(
                  text: 'All caught up. There are no local pending changes.'),
            ...c.pending.map((op) => Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: Card(
                    child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                  '${op['type'] == 'booking' ? 'Walk-in booking' : 'Cash sale'} · ${op['status']}',
                                  style: const TextStyle(
                                      fontSize: 18, color: gold)),
                              const SizedBox(height: 10),
                              SelectableText('Operation ${op['id']}',
                                  style: const TextStyle(
                                      fontSize: 10, color: Colors.white38)),
                              const SizedBox(height: 10),
                              Text(
                                  op['type'] == 'booking'
                                      ? '${op['payload']['customerName']} · ${op['payload']['resourceId']}\n${op['payload']['date']} · ${hours(op['payload'] as Json)}'
                                      : 'Cash tendered: ${money(op['payload']['tendered'])}\n${(op['payload']['items'] as List).map((i) => '${i['quantity']} × ${i['productId']}').join(', ')}${op['payload']['bookingId'] == null ? '' : '\nReservation: ${op['payload']['bookingId']}'}',
                                  style: const TextStyle(height: 1.6)),
                              if (op['error'] != null)
                                Padding(
                                    padding: const EdgeInsets.symmetric(
                                        vertical: 12),
                                    child: Text(
                                        '${op['error']} (${op['code'] ?? 'review'})',
                                        style: const TextStyle(
                                            color: Colors.orangeAccent))),
                              Wrap(spacing: 10, runSpacing: 8, children: [
                                TextButton(
                                    onPressed: c.busy
                                        ? null
                                        : () => c.run(() async {
                                              await c.outbox
                                                  .retry(op['id'] as String);
                                              await c.synchronize();
                                            }),
                                    child: Text('Retry same operation')),
                                if (op['type'] == 'booking' &&
                                    op['status'] != 'pending')
                                  TextButton(
                                      onPressed: c.busy
                                          ? null
                                          : () async {
                                              if (!await confirm(
                                                  context,
                                                  'Replace this conflict?',
                                                  'The original stays safe while you edit. After a new booking is durably saved, explicitly discard the old conflict to avoid replaying both.')) {
                                                return;
                                              }
                                              if (context.mounted) {
                                                await bookingDialog(context, c,
                                                    draft:
                                                        op['payload'] as Json);
                                              }
                                            },
                                      child: const Text('Edit as new')),
                                TextButton(
                                    onPressed: c.busy
                                        ? null
                                        : () async {
                                            if (await confirm(
                                                context,
                                                'Discard local ${op['type']}?',
                                                'This permanently removes only this local queued change. A cash sale may already have reached the server if its response was lost. Refresh server transactions before discarding. It does not refund or reverse any accepted payment.')) {
                                              await c.run(() => c.outbox
                                                  .discard(op['id'] as String));
                                            }
                                          },
                                    child: const Text('Discard…',
                                        style: TextStyle(
                                            color: Colors.orangeAccent))),
                              ]),
                            ]))))),
          ]);
}

class Workspace extends StatelessWidget {
  const Workspace({super.key, required this.c});
  final OwnerController c;
  @override
  Widget build(BuildContext context) => PageBody(
          title: 'Your workspace',
          subtitle:
              'A small team. A thoughtful space. Employee management requires a live API connection.',
          children: [
            Card(
                child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(Icons.person_outline,
                              color: gold, size: 32),
                          const SizedBox(height: 14),
                          Text('${c.snapshot['user']?['name']}',
                              style: const TextStyle(fontSize: 24)),
                          Text('${c.snapshot['user']?['email']} · Owner',
                              style: const TextStyle(color: Colors.white54)),
                          const SizedBox(height: 14),
                          SelectableText(c.api.baseUrl,
                              style: const TextStyle(
                                  color: Colors.white38, fontSize: 12)),
                          const SizedBox(height: 16),
                          OutlinedButton.icon(
                              onPressed: c.busy
                                  ? null
                                  : () async {
                                      if (c.pendingCount > 0) {
                                        await showDialog<void>(
                                            context: context,
                                            builder: (context) => AlertDialog(
                                                    title: const Text(
                                                        'Resolve queued changes first'),
                                                    content: Text(
                                                        '${c.pendingCount} local changes are still recoverable in Sync center. Review or synchronize them before signing out.'),
                                                    actions: [
                                                      TextButton(
                                                          onPressed: () =>
                                                              Navigator.pop(
                                                                  context),
                                                          child: const Text(
                                                              'Understood'))
                                                    ]));
                                        return;
                                      }
                                      if (await confirm(
                                          context,
                                          'Sign out of this device?',
                                          'An online sign-in will be required to open your cached workspace again.')) {
                                        await c.run(c.logout);
                                      }
                                    },
                              icon: const Icon(Icons.logout),
                              label: const Text('Sign out')),
                        ]))),
            const SizedBox(height: 30),
            Row(children: [
              const Expanded(
                  child: Text('Your team',
                      style: TextStyle(
                          fontSize: 23, fontWeight: FontWeight.w600))),
              TextButton.icon(
                  onPressed: !c.online || c.busy
                      ? null
                      : () => employeeDialog(context, c),
                  icon: const Icon(Icons.person_add_alt),
                  label: Text('Add employee'))
            ]),
            const SizedBox(height: 14),
            if (c.records('employees').isEmpty)
              const EmptyState(text: 'No employee accounts yet.'),
            ...c.records('employees').map((employee) => Card(
                child: ListTile(
                    leading:
                        const CircleAvatar(child: Icon(Icons.person_outline)),
                    title: Text(employee['name'] as String),
                    subtitle: Text(employee['email'] as String),
                    trailing: Switch(
                        value: employee['active'] == true ||
                            employee['active'] == 1,
                        onChanged:
                            !c.online || c.busy || employee['role'] == 'owner'
                                ? null
                                : (value) async {
                                    if (await confirm(
                                        context,
                                        value
                                            ? 'Activate employee?'
                                            : 'Disable employee?',
                                        '${employee['name']} will ${value ? 'gain' : 'lose'} employee access.')) {
                                      await c.run(() => c.employeeStatus(
                                          employee['id'] as String, value));
                                    }
                                  })))),
            const SizedBox(height: 28),
            Text('RECENT AUDIT ACTIVITY',
                style: const TextStyle(
                    color: gold, letterSpacing: 2, fontSize: 11)),
            const SizedBox(height: 12),
            ...c.records('audit').take(20).map((entry) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.history, size: 20),
                title:
                    Text('${entry['action'] ?? entry['type'] ?? 'Activity'}'),
                subtitle: Text(
                    '${entry['createdAt'] ?? ''} · ${entry['actorId'] ?? entry['userId'] ?? ''}'))),
          ]);
}

Future<void> employeeDialog(BuildContext context, OwnerController c) async {
  final name = TextEditingController(),
      email = TextEditingController(),
      password = TextEditingController();
  String? error;
  await showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
          builder: (context, update) => AlertDialog(
                  title: Text('Add an employee'),
                  content: SizedBox(
                      width: 400,
                      child: SingleChildScrollView(
                          child:
                              Column(mainAxisSize: MainAxisSize.min, children: [
                        Text(
                            'Employees sign in on the website. This app stays Owner only.',
                            style: const TextStyle(color: Colors.white54)),
                        const SizedBox(height: 20),
                        TextField(
                            controller: name,
                            decoration:
                                const InputDecoration(labelText: 'Full name')),
                        const SizedBox(height: 12),
                        TextField(
                            controller: email,
                            keyboardType: TextInputType.emailAddress,
                            decoration:
                                const InputDecoration(labelText: 'Email')),
                        const SizedBox(height: 12),
                        TextField(
                            controller: password,
                            obscureText: true,
                            decoration: const InputDecoration(
                                labelText:
                                    'Temporary password (12+ characters)')),
                        if (error != null)
                          Padding(
                              padding: const EdgeInsets.only(top: 12),
                              child: Text(error!,
                                  style: const TextStyle(
                                      color: Colors.orangeAccent))),
                      ]))),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(context),
                        child: const Text('Back')),
                    FilledButton(
                        onPressed: () async {
                          if (name.text.trim().isEmpty ||
                              !email.text.contains('@') ||
                              password.text.length < 12) {
                            update(() => error =
                                'Complete all fields; password needs at least 12 characters.');
                            return;
                          }
                          final ok = await c.run(() => c.createEmployee(
                              name.text.trim(),
                              email.text.trim(),
                              password.text));
                          if (!context.mounted) return;
                          if (ok) {
                            Navigator.pop(context);
                          } else {
                            update(() => error = c.error);
                          }
                        },
                        child: Text('Create employee'))
                  ])));
  name.dispose();
  email.dispose();
  password.dispose();
}

Future<bool> confirm(BuildContext context, String title, String body) async =>
    await showDialog<bool>(
        context: context,
        builder: (context) =>
            AlertDialog(title: Text(title), content: Text(body), actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Keep current')),
              FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: const Text('Continue'))
            ])) ??
    false;

Future<void> receiptDialog(BuildContext context, Json sale) => showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
            title: Text('CLINCH · Cash receipt'),
            content: SizedBox(
                width: 360,
                child: SingleChildScrollView(
                    child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                      Text('${sale['reference']}',
                          style: const TextStyle(color: gold, fontSize: 20)),
                      const SizedBox(height: 8),
                      Text('${sale['createdAt']}',
                          style: const TextStyle(
                              color: Colors.white54, fontSize: 12)),
                      const Divider(height: 30),
                      ...((sale['items'] as List?) ?? []).map((item) => Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: Text(
                              '${item['quantity']} × ${item['name'] ?? item['productId']}'))),
                      if (sale['bookingId'] != null)
                        Text('Reservation ${sale['bookingId']}'),
                      const Divider(height: 30),
                      Text('Total ${money(sale['total'])}',
                          style: const TextStyle(color: gold, fontSize: 24)),
                      const SizedBox(height: 12),
                      Text(
                          'Cash ${money(sale['tendered'])}\nChange ${money(sale['change'])}',
                          style: const TextStyle(height: 1.8)),
                      const SizedBox(height: 16),
                      Text('Accepted by the server · cash collection record',
                          style: const TextStyle(
                              color: Colors.white38, fontSize: 11)),
                    ]))),
            actions: [
              FilledButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Done'))
            ]));
