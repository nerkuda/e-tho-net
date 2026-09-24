/**
 * Сегментный переключатель — единый фасад `lib/ui` (задача f351b894,
 * требование e64083b5, ADR 03eb2c61, инвентаризация 3fc7c54d — раздел
 * «SegmentedControl»).
 *
 * Ряд взаимоисключающих переключателей: активен ровно один. Сегменты
 * собираются из словаря кнопок (`./button.ts` — `iconButton`/`uiButton` +
 * `setButtonActive`), поэтому вид кнопок и их состояния не дублируются, а
 * классы `ui-btn*` остаются объявлены только в словаре. Фасад владеет
 * разметкой ряда, состоянием «активен один» и ARIA (`role="group"`,
 * `aria-pressed` на сегментах).
 *
 * Своя реализация, а не `wa-tab-group`/сегмент вендора: тестируемость на
 * общем DOM-шиме (custom elements вендора в нём не исполняются) — та же
 * причина, что у `./tabs.ts`; API фасада стабилен (ADR 03eb2c61).
 */

import { div } from '../dom.js';
import { iconButton, setButtonActive, uiButton, type ButtonRole, type ButtonSize } from './button.js';

/** Класс ряда сегментов. */
export const SEGMENTED_CLASS = 'ui-segmented';

/** Один сегмент: подпись или иконка (ровно одно осмысленно). */
export interface SegmentSpec {
  /** Устойчивый идентификатор сегмента. */
  id: string;
  /** Текстовая подпись сегмента. */
  label?: string;
  /** Содержимое-иконка (например, `svgIcon(...)`). */
  icon?: Node;
  /** Подсказка (`title`); у иконочного сегмента — обязательна. */
  title?: string;
}

/** Опции {@link segmentedControl}. */
export interface SegmentedOptions {
  items: SegmentSpec[];
  /** Активный сегмент при построении; по умолчанию — первый. */
  activeId?: string;
  /** Доступное имя ряда (обязательно, когда нет видимой подписи). */
  ariaLabel?: string;
  /** Роль кнопок-сегментов; по умолчанию `ghost`. */
  role?: ButtonRole;
  size?: ButtonSize;
  /** Дополнительные классы ряда. */
  extraClass?: string;
  onChange?: (id: string) => void;
}

/** Дескриптор построенного ряда. */
export interface SegmentedHandle {
  root: HTMLDivElement;
  /** Идентификатор активного сегмента. */
  activeId(): string;
  /** Делает сегмент активным (безопасно для отсутствующего id). */
  setActive(id: string): void;
}

/**
 * Строит ряд сегментов. Активность — единственный видимый переключатель:
 * у активного сегмента поднят `aria-pressed` и включён класс активной кнопки.
 */
export function segmentedControl(o: SegmentedOptions): SegmentedHandle {
  const root = div(SEGMENTED_CLASS);
  if (o.extraClass !== undefined && o.extraClass.trim() !== '') {
    root.classList.add(...o.extraClass.trim().split(/\s+/));
  }
  root.setAttribute('role', 'group');
  if (o.ariaLabel !== undefined) root.setAttribute('aria-label', o.ariaLabel);

  const buttons = new Map<string, HTMLButtonElement>();
  const first = o.items[0]?.id ?? '';
  let active =
    o.activeId !== undefined && o.items.some((i) => i.id === o.activeId) ? o.activeId : first;

  const apply = (emit: boolean): void => {
    for (const [id, btn] of buttons) {
      const on = id === active;
      setButtonActive(btn, on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (emit) o.onChange?.(active);
  };

  for (const item of o.items) {
    const btn =
      item.icon !== undefined
        ? iconButton({
            icon: item.icon,
            title: item.title ?? item.label ?? '',
            role: o.role ?? 'ghost',
            size: o.size,
            onClick: () => {
              if (active === item.id) return;
              active = item.id;
              apply(true);
            },
          })
        : uiButton({
            label: item.label ?? '',
            title: item.title,
            role: o.role ?? 'ghost',
            size: o.size,
            onClick: () => {
              if (active === item.id) return;
              active = item.id;
              apply(true);
            },
          });
    buttons.set(item.id, btn);
    root.append(btn);
  }

  apply(false);

  return {
    root,
    activeId: () => active,
    setActive: (id: string): void => {
      if (!buttons.has(id) || id === active) return;
      active = id;
      apply(false);
    },
  };
}
