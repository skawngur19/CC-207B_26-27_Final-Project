import 'package:flutter/material.dart';
import '../data/owner_controller.dart';
import '../core/outbox.dart';

class TerminalPanel extends StatelessWidget {
  const TerminalPanel({super.key, required this.controller});
  final OwnerController controller;

  Future<void> _pair(BuildContext context, String operatorId) async {
    String? secret;
    final ok = await controller.run(() async {
      controller.requireLease();
      secret = await controller.terminal!.pair(operatorId);
    });
    if (!ok || !context.mounted || !controller.accessible) return;
    await showDialog<void>(
        context: context,
        builder: (dialog) => AlertDialog(
                title: const Text('Pair this browser'),
                content: SingleChildScrollView(
                    child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                      Text(
                          'On this PC, open ${controller.terminal!.origin} as the selected operator. Paste this key into the terminal pairing form.'),
                      const SizedBox(height: 16),
                      SelectableText(secret!),
                      const SizedBox(height: 12),
                      const Text(
                          'Keep this key private. Pair again to replace it.')
                    ])),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(dialog),
                      child: const Text('Done'))
                ]));
  }

  Future<void> _details(BuildContext context, Json row) async {
    final item = await controller.terminal!.details(row['id']);
    if (!context.mounted || !controller.accessible) return;
    final receipt = item['receipt'] as Json;
    final result = item['cloudResult'] as Json?;
    final prior = item['printing'] != 'waiting';
    final send = await showDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
                title: const Text('Browser cash receipt'),
                content: SingleChildScrollView(
                    child: SelectableText([
                  item['id'],
                  'Cloud status: ${item['status']}',
                  'Printer: ${item['printing']}',
                  'Operator: ${receipt['operatorId']}',
                  'Shift: ${receipt['shiftId']} · #${receipt['sequence']}',
                  'Recorded: ${receipt['occurredAt']}',
                  'Cash tendered: ₱${(receipt['tendered'] / 100).toStringAsFixed(2)}',
                  for (final line in receipt['items'] as List)
                    "${line['quantity']} × ${line['productId']} at ₱${(line['unitPrice'] / 100).toStringAsFixed(2)}",
                  if (receipt['bookingId'] != null)
                    'Reservation: ${receipt['bookingId']}',
                  if (result?['error'] != null) 'Review: ${result!['error']}',
                  if (prior)
                    'Check the previous paper output before requesting a marked reprint.'
                ].join('\n'))),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(dialog, false),
                      child: const Text('Close')),
                  FilledButton(
                      onPressed: () => Navigator.pop(dialog, true),
                      child:
                          Text(prior ? 'Print marked copy' : 'Print receipt'))
                ]));
    if (send == true && controller.accessible) {
      await controller.run(
          () => controller.terminal!.printReceipt(row['id'], reprint: prior));
    }
  }

  Future<void> _review(BuildContext context, Json review) async {
    final receipt = review['receipt'] as Json;
    var note = '';
    final accepted = await showDialog<bool>(
        context: context,
        builder: (dialog) => StatefulBuilder(
            builder: (context, setState) => AlertDialog(
                    title: const Text('Reconcile cash record'),
                    content: SingleChildScrollView(
                        child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                          Text(
                              '${review['error']}\n\nReceipt ${receipt['operationId']}\nOperator ${receipt['operatorId']} · shift ${receipt['shiftId']}\nCash received ₱${((receipt['tendered'] as int) / 100).toStringAsFixed(2)}'),
                          const SizedBox(height: 12),
                          TextField(
                              maxLines: 3,
                              maxLength: 500,
                              decoration: const InputDecoration(
                                  labelText: 'Reconciliation note'),
                              onChanged: (text) =>
                                  setState(() => note = text.trim())),
                          const Text(
                              'This records your review in the audit log. Any cash or stock correction is a separate action.')
                        ])),
                    actions: [
                      TextButton(
                          onPressed: () => Navigator.pop(dialog, false),
                          child: const Text('Cancel')),
                      FilledButton(
                          onPressed: note.length < 3
                              ? null
                              : () => Navigator.pop(dialog, true),
                          child: const Text('Record review'))
                    ])));
    if (accepted == true && controller.accessible) {
      await controller.run(() async {
        controller.requireLease();
        await controller.api.call(
            '/terminal/reviews/${Uri.encodeComponent(review['id'])}',
            body: {'note': note});
        await controller.refresh();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = controller, engine = c.terminal!;
    final receipts = engine.recent;
    final staff = [
      c.snapshot['user'] as Json,
      ...c.records('employees').where((e) => e['active'] == true)
    ];
    return Card(
        child: Padding(
            padding: const EdgeInsets.all(20),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Browser terminal',
                  style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              Text(engine.listening
                  ? 'Listening on this PC · ${engine.pending} waiting for cloud sync'
                  : 'Pair an operator to receive browser sales on this PC.'),
              if (engine.notice != null)
                Text(engine.notice!,
                    style: TextStyle(
                        color: Theme.of(context).colorScheme.primary)),
              Wrap(spacing: 12, children: [
                PopupMenuButton<String>(
                    enabled: !c.busy && c.online,
                    onSelected: (id) => _pair(context, id),
                    itemBuilder: (_) => [
                          for (final user in staff)
                            PopupMenuItem(
                                value: user['id'] as String,
                                child:
                                    Text('${user['name']} · ${user['role']}'))
                        ],
                    child: const Padding(
                        padding: EdgeInsets.all(12),
                        child: Text('Pair operator…'))),
                if (engine.operators.isNotEmpty)
                  PopupMenuButton<String>(
                      enabled: !c.busy,
                      onSelected: (id) => c.run(() => engine.unpair(id)),
                      itemBuilder: (_) => [
                            for (final id in engine.operators)
                              PopupMenuItem(
                                  value: id,
                                  child: Text(staff
                                          .where((s) => s['id'] == id)
                                          .firstOrNull?['name'] ??
                                      id))
                          ],
                      child: const Padding(
                          padding: EdgeInsets.all(12),
                          child: Text('Remove pairing…'))),
                if (engine.operators.isNotEmpty && !engine.listening)
                  TextButton(
                      onPressed: () => engine.listen(),
                      child: const Text('Retry connection'))
              ]),
              if (engine.operators.isNotEmpty || receipts.isNotEmpty)
                SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Print waiting receipts automatically'),
                    subtitle: const Text(
                        'Uses the default physical printer in Windows.'),
                    value: engine.autoPrint,
                    onChanged: c.busy
                        ? null
                        : (value) => c.run(() => engine.setAutoPrint(value))),
              for (final row in receipts)
                ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.receipt_long_outlined),
                    title: Text(row['id'], overflow: TextOverflow.ellipsis),
                    subtitle:
                        Text('${row['status']} · Print: ${row['printing']}'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => _details(context, row)),
              for (final review in c.records('terminalReviews'))
                ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.pending_actions),
                    title: Text(review['error']),
                    subtitle: Text('Owner review · ${review['code']}'),
                    onTap: c.online && !c.busy
                        ? () => _review(context, review)
                        : null),
            ])));
  }
}
