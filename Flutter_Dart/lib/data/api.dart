import 'dart:convert';
import 'package:http/http.dart' as http;
import '../core/outbox.dart';

class ApiFailure implements Exception {
  ApiFailure(this.message, this.code, this.status);
  final String message;
  final String code;
  final int status;
  @override
  String toString() => message;
}

class Api {
  Api(this.baseUrl);
  final String baseUrl;
  final http.Client _client = http.Client();
  String? token;

  Future<Json> call(String path, {Json? body}) async {
    final uri = Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}/api$path');
    final headers = <String, String>{
      'Accept': 'application/json',
      if (body != null) 'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token'
    };
    final response = await (body == null
            ? _client.get(uri, headers: headers)
            : _client.post(uri, headers: headers, body: jsonEncode(body)))
        .timeout(const Duration(seconds: 10));
    Json data;
    try {
      data = jsonDecode(response.body) as Json;
    } catch (_) {
      throw ApiFailure('The server returned an unreadable response.',
          'invalid_response', response.statusCode);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiFailure(data['error']?.toString() ?? 'Request failed.',
          data['code']?.toString() ?? 'request_failed', response.statusCode);
    }
    if (data['demo'] == true) {
      throw ApiFailure('Connect to the account-enabled Clinch service.',
          'INVALID_WORKSPACE', 403);
    }
    return data;
  }

  void dispose() => _client.close();
}
