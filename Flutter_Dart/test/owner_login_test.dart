import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:clinch_owner/data/api.dart';
import 'package:clinch_owner/data/owner_controller.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('debug demo credentials are sent only to a loopback API', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final received = Completer<Map<String, dynamic>>();
    final subscription = server.listen((request) async {
      final body = jsonDecode(await utf8.decoder.bind(request).join())
          as Map<String, dynamic>;
      received.complete(body);
      request.response.statusCode = HttpStatus.unauthorized;
      request.response.write(jsonEncode({'error': 'Expected test rejection.'}));
      await request.response.close();
    });
    final api = Api('http://127.0.0.1:${server.port}');
    try {
      await expectLater(OwnerController(api).login('1234', '1234'),
          throwsA(isA<ApiFailure>()));
      final body = await received.future;
      expect(body['email'], '1234');
      expect(body['password'], '1234');
      expect(body['role'], 'owner');

      await expectLater(
          OwnerController(Api('https://example.com')).login('1234', '1234'),
          throwsFormatException);
    } finally {
      api.dispose();
      await subscription.cancel();
      await server.close(force: true);
    }
  });
}
