/**
 * Mermaid-диаграммы (M7): блоки ```mermaid рендерит mermaid.js — и в
 * HTML-просмотре, и в виджетах live preview. Источник блока единый: рендерер
 * @etn/markdown выдаёт `<pre class="mermaid">…</pre>`, а этот модуль
 * (ленивый dynamic import mermaid) заменяет его на SVG. Ошибки синтаксиса
 * оставляют исходный код на месте.
 */

/** Модуль mermaid грузится только при первой встрече с диаграммой. */
let mermaidPromise: Promise<typeof import('mermaid')> | null = null;

function loadMermaid(): Promise<typeof import('mermaid')> {
  mermaidPromise ??= import('mermaid');
  return mermaidPromise;
}

let initialized = false;
let counter = 0;

/** Рендерит все `pre.mermaid` внутри `container` в SVG (бесшумно при ошибках). */
export function renderMermaidBlocks(container: HTMLElement): void {
  const blocks = container.querySelectorAll<HTMLElement>('pre.mermaid');
  if (blocks.length === 0) return;
  void loadMermaid()
    .then((module) => {
      const mermaid = module.default;
      if (!initialized) {
        mermaid.initialize({ startOnLoad: false });
        initialized = true;
      }
      for (const block of blocks) {
        const code = block.querySelector('code')?.textContent ?? '';
        if (code.trim() === '') continue;
        const id = `etn-mmd-${++counter}`;
        mermaid
          .render(id, code)
          .then(({ svg }) => {
            if (block.isConnected) {
              block.classList.add('mermaid-rendered');
              block.innerHTML = svg;
            }
          })
          .catch(() => {
            // Синтаксическая ошибка диаграммы — оставляем код для правки.
          });
      }
    })
    .catch(() => undefined);
}
