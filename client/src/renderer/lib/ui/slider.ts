/**
 * Ползунок — единый фасад `lib/ui` (задача ea1b5f14, дополнение пользователя
 * 2026-10-02 «ползунок ширины текста»; инвентаризация дизайн-системы не имела
 * раздела «Slider»).
 *
 * Диапазонный регулятор числового значения: владелец задаёт границы, шаг,
 * начальное значение, доступное имя и два обработчика — потоковый (`onInput`)
 * и завершающий (`onChange`). Разметка, ARIA-состояние и показ текущего
 * значения (подсказка) живут здесь, поэтому экраны не собирают `<input
 * type="range">` вручную (сторож `guard-ui-slider.test.ts`).
 *
 * Реализация — натив `<input type="range">` под классом фасада, а не вендорский
 * компонент: в наборе `lib/ui/register.ts` ползунка нет, а нативный контрол
 * даёт готовую клавиатуру (стрелки/Home/End) и доступность. Вид задаёт
 * `./slider.css` по токенам темы.
 */

import { el, setTooltip } from '../dom.js';

/** Класс корня ползунка. */
export const SLIDER_CLASS = 'ui-slider';

/** Опции {@link uiSlider}. */
export interface SliderOptions {
  /** Нижняя граница диапазона. */
  min: number;
  /** Верхняя граница диапазона. */
  max: number;
  /** Шаг (по умолчанию 1). */
  step?: number;
  /** Начальное значение (по умолчанию — нижняя граница). */
  value?: number;
  /** Доступное имя (обязательно: короткий контрол без видимой подписи). */
  ariaLabel: string;
  /**
   * Текст текущего значения для подсказки и `aria-valuetext`; по умолчанию —
   * само число. Владелец решает, добавлять ли знак `%` (фасад единиц не знает).
   */
  formatValue?: (value: number) => string;
  /** Потоковое изменение значения (движение ползунка, стрелки). */
  onInput?: (value: number) => void;
  /** Завершение изменения (событие `change`). */
  onChange?: (value: number) => void;
}

/** Дескриптор построенного ползунка. */
export interface SliderHandle {
  /** Корневой узел (обёртка над нативным контролом). */
  root: HTMLElement;
  /** Текущее значение. */
  value(): number;
  /** Задать значение (обрезается по границам; обработчики не зовутся). */
  setValue(value: number): void;
}

/** Обрезает значение по границам диапазона и притягивает к шагу. */
function clamp(value: number, min: number, max: number, step: number): number {
  const snapped = step > 0 ? Math.round(value / step) * step : value;
  return Math.min(max, Math.max(min, snapped));
}

/**
 * Строит ползунок и возвращает дескриптор. Подсказка и `aria-valuetext`
 * обновляются на каждом изменении — текущее значение видно без отдельной
 * подписи в тулбаре (требование карточки).
 */
export function uiSlider(opts: SliderOptions): SliderHandle {
  const { min, max } = opts;
  const step = opts.step ?? 1;
  const format = opts.formatValue ?? ((value: number) => String(value));
  const root = el('input', SLIDER_CLASS);
  root.type = 'range';
  root.min = String(min);
  root.max = String(max);
  root.step = String(step);
  root.value = String(clamp(opts.value ?? min, min, max, step));
  root.setAttribute('aria-label', opts.ariaLabel);

  const sync = (): void => {
    const text = format(Number(root.value));
    setTooltip(root, text);
    root.setAttribute('aria-valuetext', text);
  };
  sync();

  root.addEventListener('input', () => {
    sync();
    opts.onInput?.(Number(root.value));
  });
  root.addEventListener('change', () => {
    sync();
    opts.onChange?.(Number(root.value));
  });

  return {
    root,
    value: () => Number(root.value),
    setValue: (value: number) => {
      root.value = String(clamp(value, min, max, step));
      sync();
    },
  };
}
