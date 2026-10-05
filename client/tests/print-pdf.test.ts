/**
 * Печать HTML в PDF скрытым окном Electron (0.11.2, задача 178f4921).
 *
 * PDF публикации формирует клиент: серверный печатный HTML грузится в скрытое
 * окно и снимается `webContents.printToPDF`. Тест проверяет оркестрацию
 * (временный файл → загрузка → ожидание картинок → печать → уборка) на
 * подставном окне — без настоящей печати, как требует DoD п.7.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  printHtmlToPdf,
  type PdfPrintDeps,
  type PdfPrintOptions,
  type PdfPrintWindow,
} from '../src/main/print-pdf.js';

interface FakeWindowLog {
  loaded: string[];
  executed: string[];
  printed: PdfPrintOptions[];
  destroyed: number;
}

/** Подставное скрытое окно: пишет вызовы и возвращает «PDF». */
function makeWindow(log: FakeWindowLog, pdf: Buffer | Error): PdfPrintWindow {
  return {
    loadURL: async (url: string) => {
      log.loaded.push(url);
    },
    webContents: {
      printToPDF: async (options: PdfPrintOptions) => {
        log.printed.push(options);
        if (pdf instanceof Error) throw pdf;
        return pdf;
      },
      executeJavaScript: async (code: string) => {
        log.executed.push(code);
        return true;
      },
    },
    destroy: () => {
      log.destroyed += 1;
    },
  };
}

/** Собрать внедряемые зависимости вокруг подставного окна. */
function makeDeps(
  log: FakeWindowLog,
  pdf: Buffer | Error,
  removed: string[],
  tempPath = 'C:\\etn-tmp\\pub.html',
): PdfPrintDeps {
  return {
    createWindow: () => makeWindow(log, pdf),
    writeTempHtml: (html) => {
      assert.equal(html, '<!doctype html><html></html>');
      return tempPath;
    },
    removeFile: (filePath) => {
      removed.push(filePath);
    },
  };
}

describe('print-pdf: печать HTML в PDF', () => {
  it('грузит temp-файл, ждёт картинки, печатает A4 с фоном, убирает за собой', async () => {
    const log: FakeWindowLog = { loaded: [], executed: [], printed: [], destroyed: 0 };
    const removed: string[] = [];
    const pdf = Buffer.from('%PDF-1.4 fake');
    const result = await printHtmlToPdf(
      '<!doctype html><html></html>',
      makeDeps(log, pdf, removed),
    );

    assert.equal(result, pdf);
    assert.equal(log.loaded.length, 1);
    assert.match(log.loaded[0]!, /^file:\/\//);
    assert.ok(log.loaded[0]!.includes('pub.html'), log.loaded[0]);
    assert.equal(log.executed.length, 1);
    assert.ok(log.executed[0]!.includes('document.images'), 'ожидание картинок');
    assert.deepEqual(log.printed, [{ printBackground: true, pageSize: 'A4' }]);
    assert.equal(log.destroyed, 1);
    assert.deepEqual(removed, ['C:\\etn-tmp\\pub.html']);
  });

  it('ошибка печати: окно и temp-файл всё равно освобождаются, ошибка пробрасывается', async () => {
    const log: FakeWindowLog = { loaded: [], executed: [], printed: [], destroyed: 0 };
    const removed: string[] = [];
    await assert.rejects(
      () =>
        printHtmlToPdf(
          '<!doctype html><html></html>',
          makeDeps(log, new Error('print failed'), removed),
        ),
      /print failed/,
    );
    assert.equal(log.destroyed, 1);
    assert.deepEqual(removed, ['C:\\etn-tmp\\pub.html']);
  });

  it('недоступное ожидание картинок не срывает печать (best-effort)', async () => {
    const log: FakeWindowLog = { loaded: [], executed: [], printed: [], destroyed: 0 };
    const removed: string[] = [];
    const deps: PdfPrintDeps = {
      createWindow: () => {
        const win = makeWindow(log, Buffer.from('%PDF-1.4'));
        win.webContents.executeJavaScript = async () => {
          throw new Error('no document');
        };
        return win;
      },
      writeTempHtml: () => 'C:\\etn-tmp\\pub.html',
      removeFile: (filePath) => removed.push(filePath),
    };
    const result = await printHtmlToPdf('<!doctype html><html></html>', deps);
    assert.equal(result.toString(), '%PDF-1.4');
    assert.equal(log.destroyed, 1);
    assert.deepEqual(removed, ['C:\\etn-tmp\\pub.html']);
  });
});
