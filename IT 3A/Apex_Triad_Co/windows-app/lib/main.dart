import 'package:flutter/material.dart';
import 'data/api.dart';
import 'data/owner_controller.dart';
import 'ui/owner_app.dart';

void main(List<String> args) {
  WidgetsFlutterBinding.ensureInitialized();
  const defaultOrigin = String.fromEnvironment('CLINCH_API_URL',
      defaultValue: 'http://127.0.0.1:8787');
  final origin = args
          .where((arg) => arg.startsWith('--api-origin='))
          .map((arg) => arg.substring('--api-origin='.length))
          .firstOrNull ??
      defaultOrigin;
  runApp(ClinchApp(controller: OwnerController(Api(origin))));
}
