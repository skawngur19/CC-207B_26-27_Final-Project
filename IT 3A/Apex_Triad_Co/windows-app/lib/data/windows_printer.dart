import 'dart:ffi';
import 'dart:isolate';
import 'dart:math';
import 'package:ffi/ffi.dart';

final class _DocInfo extends Struct {
  @Int32()
  external int size;
  external Pointer<Utf16> name;
  external Pointer<Utf16> output;
  external Pointer<Utf16> datatype;
  @Uint32()
  external int flags;
}

/// Drivers can block even while opening a printer. Keep spooler work off the UI.
Future<void> spoolReceipt(List<String> lines) =>
    Isolate.run(() => _spool(lines));

void _spool(List<String> lines) {
  final spool = DynamicLibrary.open('winspool.drv');
  final gdi = DynamicLibrary.open('gdi32.dll');
  final defaultPrinter = spool.lookupFunction<
      Int32 Function(Pointer<Utf16>, Pointer<Uint32>),
      int Function(Pointer<Utf16>, Pointer<Uint32>)>('GetDefaultPrinterW');
  final create = gdi.lookupFunction<
      IntPtr Function(
          Pointer<Utf16>, Pointer<Utf16>, Pointer<Utf16>, Pointer<Void>),
      int Function(Pointer<Utf16>, Pointer<Utf16>, Pointer<Utf16>,
          Pointer<Void>)>('CreateDCW');
  final start = gdi.lookupFunction<Int32 Function(IntPtr, Pointer<_DocInfo>),
      int Function(int, Pointer<_DocInfo>)>('StartDocW');
  final caps =
      gdi.lookupFunction<Int32 Function(IntPtr, Int32), int Function(int, int)>(
          'GetDeviceCaps');
  final write = gdi.lookupFunction<
      Int32 Function(IntPtr, Int32, Int32, Pointer<Utf16>, Int32),
      int Function(int, int, int, Pointer<Utf16>, int)>('TextOutW');
  final createFont = gdi.lookupFunction<
      IntPtr Function(Int32, Int32, Int32, Int32, Int32, Uint32, Uint32, Uint32,
          Uint32, Uint32, Uint32, Uint32, Uint32, Pointer<Utf16>),
      int Function(int, int, int, int, int, int, int, int, int, int, int, int,
          int, Pointer<Utf16>)>('CreateFontW');
  final select = gdi.lookupFunction<IntPtr Function(IntPtr, IntPtr),
      int Function(int, int)>('SelectObject');
  final delete = gdi.lookupFunction<Int32 Function(IntPtr), int Function(int)>(
      'DeleteObject');
  final startPage = gdi
      .lookupFunction<Int32 Function(IntPtr), int Function(int)>('StartPage');
  final endPage =
      gdi.lookupFunction<Int32 Function(IntPtr), int Function(int)>('EndPage');
  final end =
      gdi.lookupFunction<Int32 Function(IntPtr), int Function(int)>('EndDoc');
  final abort =
      gdi.lookupFunction<Int32 Function(IntPtr), int Function(int)>('AbortDoc');
  final dispose =
      gdi.lookupFunction<Int32 Function(IntPtr), int Function(int)>('DeleteDC');
  using((arena) {
    final length = arena<Uint32>();
    defaultPrinter(nullptr, length);
    if (length.value == 0 || length.value > 32768) {
      throw StateError('Select a default physical receipt printer in Windows.');
    }
    final printer = arena<Uint16>(length.value).cast<Utf16>();
    if (defaultPrinter(printer, length) == 0) {
      throw StateError('Default printer unavailable.');
    }
    final printerName = printer.toDartString().toLowerCase();
    if (printerName.contains('pdf') ||
        printerName.contains('xps') ||
        printerName.contains('onenote') ||
        printerName == 'fax') {
      throw StateError(
          'Select a physical receipt printer as the Windows default.');
    }
    final dc = create(
        'WINSPOOL'.toNativeUtf16(allocator: arena), printer, nullptr, nullptr);
    if (dc == 0) throw StateError('Could not open the default printer.');
    var active = false;
    var font = 0;
    var previous = 0;
    try {
      final doc = arena<_DocInfo>();
      doc.ref.size = sizeOf<_DocInfo>();
      doc.ref.name = 'Clinch cash receipt'.toNativeUtf16(allocator: arena);
      if (start(dc, doc) <= 0) {
        throw StateError('Windows did not accept the print job.');
      }
      active = true;
      final width = caps(dc, 8), height = caps(dc, 10);
      final charWidth = max(1, min((caps(dc, 88) / 12).round(), width ~/ 34));
      final lineHeight = max(2, (charWidth * 2.5).round());
      font = createFont(-lineHeight * 4 ~/ 5, charWidth, 0, 0, 400, 0, 0, 0, 1,
          0, 0, 0, 49, 'Consolas'.toNativeUtf16(allocator: arena));
      if (font == 0 || width <= 0 || height < lineHeight) {
        throw StateError('Printer layout is unavailable.');
      }
      previous = select(dc, font);
      if (startPage(dc) <= 0) {
        throw StateError('Could not start the receipt page.');
      }
      int y = 0;
      final columns = max(1, width ~/ charWidth - 1);
      for (final line in lines) {
        for (int i = 0; i < max(1, line.length); i += columns) {
          if (y + lineHeight > height) {
            if (endPage(dc) <= 0 || startPage(dc) <= 0) {
              throw StateError('Receipt pagination failed.');
            }
            y = 0;
          }
          final part = line.substring(i, min(line.length, i + columns));
          if (write(dc, 0, y, part.toNativeUtf16(allocator: arena),
                  part.length) ==
              0) {
            throw StateError('Receipt output failed.');
          }
          y += lineHeight;
        }
      }
      if (endPage(dc) <= 0 || end(dc) <= 0) {
        throw StateError('Print completion is unknown.');
      }
      active = false;
    } finally {
      if (active) abort(dc);
      if (previous != 0) select(dc, previous);
      if (font != 0) delete(font);
      dispose(dc);
    }
  });
}
