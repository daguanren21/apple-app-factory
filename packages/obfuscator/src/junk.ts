/**
 * Deterministic "rubbish code injection + resource cleanup" transforms:
 *
 *   - insertJunkCode   -> garbage methods into .h/.m/.mm/.swift
 *   - createJunkFiles  -> garbage .h/.m/.swift + pbxproj registration
 *   - ObjC garbage-method template pool
 *   - Swift garbage-method template pool
 *   - unused-resource detection + cleanup
 *   - ignorable-path predicate
 *
 * All randomness is seeded; `Math.random`, `Date.now` and `Math.random`-backed UUIDs are
 * never used. Identical arguments always produce byte-identical output.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  basenameWithoutExtension,
  deriveUuid,
  extension,
  seededInt,
  writeIfChanged,
  type TransformOutcome,
  type WalkEntry,
} from './common.js';

const DEFAULT_RUB_PREFIX = 'OBFObj';

// ---------------------------------------------------------------------------
// Deterministic lexicon stand-in for `random_word_from_lexicon()`.
// ---------------------------------------------------------------------------

const LEXICON: readonly string[] = [
  'amber', 'brisk', 'cobalt', 'dapper', 'eager', 'fable', 'glade', 'haven', 'ivory', 'jolly',
  'kindle', 'lumen', 'maple', 'noble', 'opal', 'pearl', 'quill', 'raven', 'sable', 'tiger',
  'umber', 'velvet', 'woven', 'xenon', 'yonder', 'zephyr', 'archer', 'bramble', 'cedar', 'drift',
  'ember', 'falcon', 'grove', 'harbor', 'indigo', 'jasper', 'kestrel', 'linden', 'meadow', 'nimbus',
  'onyx', 'petal', 'quartz', 'rune', 'saffron', 'talon', 'vale', 'willow', 'yarrow',
  'azure', 'beacon', 'cinder', 'dusk', 'eclipse', 'frost', 'gale', 'hollow', 'iris', 'juniper',
  'knoll', 'lagoon', 'mirage', 'nestle', 'oasis', 'pinnacle', 'ripple', 'solace', 'thicket',
  'vista', 'wander', 'wisp', 'acre', 'birch', 'canyon', 'delta', 'elevation', 'fjord', 'glacier',
  'highland', 'inlet', 'jetty', 'knob', 'ledge', 'marrow', 'notch', 'orchard', 'prairie', 'quarry',
  'ridge', 'summit', 'terrace', 'uplands', 'verge', 'watershed', 'woodland', 'alder', 'basin', 'clearing',
];

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** Deterministic lowercase lexicon word (seed + salt). */
export function randomWord(seed: string, salt: string): string {
  return LEXICON[seededInt(seed, `lexicon:${salt}`, 0, LEXICON.length - 1)]!;
}

/** Deterministic title-cased lexicon word. */
export function randomWordTitle(seed: string, salt: string): string {
  return capitalize(randomWord(seed, salt));
}

/** Sequential deterministic RNG. Consumes salts in call order, mirroring Python's `random.*`. */
class Rng {
  private counter = 0;

  constructor(
    private readonly seed: string,
    private readonly scope: string,
  ) {}

  private salt(): string {
    const value = `${this.scope}:${this.counter}`;
    this.counter += 1;
    return value;
  }

  int(min: number, max: number): number {
    return seededInt(this.seed, this.salt(), min, max);
  }

  pick<T>(list: readonly T[]): T {
    return list[this.int(0, list.length - 1)]!;
  }

  word(): string {
    return randomWord(this.seed, this.salt());
  }

  wordTitle(): string {
    return capitalize(this.word());
  }

  wordUpper(): string {
    return this.word().toUpperCase();
  }

  /** Deterministic `random.sample(list, k)` (Fisher-Yates partial shuffle). */
  sample<T>(list: readonly T[], k: number): T[] {
    const items = [...list];
    const count = Math.min(Math.max(0, k), items.length);
    for (let i = 0; i < count; i += 1) {
      const j = i + this.int(0, items.length - 1 - i);
      const swap = items[i]!;
      items[i] = items[j]!;
      items[j] = swap;
    }
    return items.slice(0, count);
  }
}

function dateString(rng: Rng): string {
  const year = rng.int(2018, 2026);
  const month = rng.int(1, 12);
  const day = rng.int(1, 28);
  return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Shared type/name pools.
// ---------------------------------------------------------------------------

const OBJC_FUN_HEAD_LIST: readonly string[] = [
  'void', 'CGFloat', 'CGRect', 'NSInteger', 'NSString', 'NSArray', 'NSDictionary', 'NSNumber',
  'NSURL', 'NSIndexPath', 'UIView', 'UIButton', 'UIDatePicker', 'UITextField', 'UISwitch',
  'UISlider', 'UILabel', 'UIImageView', 'UIFont', 'UIColor',
];

const SWIFT_FUN_HEAD_LIST: readonly string[] = [
  'Void', 'Bool', 'CGFloat', 'CGRect', 'NSInteger', 'NSString', 'NSArray', 'NSDictionary',
  'UIImage', 'NSURL', 'UIView', 'UIButton', 'UIDatePicker', 'UITextField', 'UISwitch',
  'UISlider', 'UILabel', 'UIImageView', 'UIFont', 'UIColor',
];

const SPORT_OBJ_LIST: readonly string[] = ['NSObject', 'UIView', 'UIViewController'];

const OBJC_NO_STARS: readonly string[] = ['void', 'CGFloat', 'CGRect', 'NSInteger'];
const OBJC_ASSIGN: readonly string[] = ['BOOL', 'CGFloat', 'CGRect', 'NSInteger'];
const OBJC_COPY: readonly string[] = ['NSString', 'NSArray', 'NSDictionary', 'UIImage', 'NSNumber', 'NSURL', 'NSIndexPath'];
const SWIFT_VAR_LIST: readonly string[] = ['BOOL', 'CGFloat', 'CGRect', 'NSInteger', 'NSString', 'UIColor', 'UIFont', 'NSURL'];

const PRO_COUNT = 3;

// Cross-class import registry (unused/used maps).
interface ClassRegistry {
  unused: Map<string, string[]>;
  used: Map<string, string[]>;
}

function newRegistry(): ClassRegistry {
  return { unused: new Map(), used: new Map() };
}

interface ObjCGenState {
  rubProMap: Map<string, string>;
  headerFiles: string[];
  registry: ClassRegistry;
}

interface SwiftGenState {
  rubProMap: Map<string, string>;
  registry: ClassRegistry;
}

// ---------------------------------------------------------------------------
// Exported result shapes.
// ---------------------------------------------------------------------------

export interface ObjCJunk {
  /** Garbage method declarations for the `.h` file. */
  hCode: string;
  /** Garbage method bodies for the `.m` file. */
  mCode: string;
  /** `#import "X.h"` lines collected from cross-class references. */
  headerImportCode: string;
  /** Method-declaration list, for cross-class import registration. */
  hFunList: string[];
}

export interface SwiftJunk {
  /** Lazy property code inserted after the class opening brace. */
  propertyCode: string;
  /** Garbage method bodies. */
  methodCode: string;
  /** `func ...` signature list, for cross-class import registration. */
  funList: string[];
}

export interface JunkCodeOptions {
  /** Number of garbage methods per class. Default 1. */
  amount?: number;
  /** Method-name prefix. Default 'OBFObj'. */
  rubPrefix?: string;
}

export interface JunkFileOptions {
  /** Number of garbage files to create. Default 1. */
  count?: number;
  /** Number of garbage methods per created file. Default 1. */
  amount?: number;
  /** Method-name prefix. Default 'OBFObj'. */
  rubPrefix?: string;
  /** Garbage file language. Default 'OC'. */
  language?: 'OC' | 'Swift';
}

export interface CleanResourcesOptions {
  /** Resource names to keep (never delete). */
  ignore?: readonly string[];
}

type ObjCSuperclass = 'NSObject' | 'UIView' | 'UIViewController';
type SwiftSuperclass = ObjCSuperclass;

// ---------------------------------------------------------------------------
// Name generation.
// ---------------------------------------------------------------------------

/** Generate a garbage ObjC class name from an existing name. */
export function objcGetMissObjName(oldObjName: string, seed: string, salt = 'objc-name'): string {
  const base = oldObjName.includes('+') ? oldObjName.split('+').at(-1)! : oldObjName;
  const words = base.replace(/[A-Z]/g, match => `_${match}`).split('_');
  let kept = words.filter(item => item.length > 2);
  if (kept.length > 2) kept = kept.slice(-2);
  if (kept.length <= 2) kept.unshift(randomWordTitle(seed, `${salt}:pre`));
  kept.unshift(randomWordTitle(seed, `${salt}:head`));
  return kept.join('');
}

/** Generate a garbage Swift class name from an existing name. */
export function swiftGetMissObjName(oldObjName: string, seed: string, salt = 'swift-name'): string {
  const title = randomWordTitle(seed, `${salt}:a`) + randomWordTitle(seed, `${salt}:b`);
  if (title.includes(DEFAULT_RUB_PREFIX)) return title;
  const lower = oldObjName.toLowerCase();
  if (oldObjName.endsWith('View') || oldObjName.endsWith('view')) return `${title}View`;
  if (lower.endsWith('controller') || lower.endsWith('control') || lower.endsWith('controll')) return `${title}Controller`;
  if (oldObjName.endsWith('Cell') || oldObjName.endsWith('cell')) return `${title}Cell`;
  if (oldObjName.endsWith('Model') || oldObjName.endsWith('model')) return `${title}Model`;
  if (lower.includes('tool')) return `${title}Tools`;
  if (oldObjName.endsWith('Label') || oldObjName.endsWith('label')) return `${title}Label`;
  if (lower.endsWith('button') || lower.endsWith('btn')) return `${title}Button`;
  if (oldObjName.endsWith('Manager') || oldObjName.endsWith('manager')) return `${title}Manager`;
  if (oldObjName.endsWith('Handler') || oldObjName.endsWith('handler')) return `${title}Handler`;
  if (oldObjName.endsWith('Operation') || oldObjName.endsWith('operation')) return `${title}Operation`;
  if (oldObjName.startsWith('UI') || oldObjName.startsWith('CG') || oldObjName.startsWith('NS')) {
    return `${randomWordTitle(seed, `${salt}:c`)}${oldObjName.slice(2)}`;
  }
  return `${title}Obj`;
}


// ---------------------------------------------------------------------------
// ObjC template pool.
// ---------------------------------------------------------------------------

function objcColor(rng: Rng): string {
  return `[UIColor colorWithRed:${rng.int(0, 255)}/255.0 green:${rng.int(0, 255)}/255.0 blue:${rng.int(0, 255)}/255.0 alpha:1.0]`;
}

function objcMethodName(rng: Rng, returnValue: string, rubPrefix: string): string {
  let suffix: string;
  if (returnValue === 'void') suffix = 'Fun';
  else if (returnValue.startsWith('CG')) suffix = returnValue.slice(2);
  else suffix = '';
  const name = rng.int(0, 1) === 0
    ? rng.word() + capitalize(rng.word()) + suffix
    : rng.word() + capitalize(rng.word()) + capitalize(rng.word()) + suffix;
  const prefixed = rubPrefix.length > 0 ? rubPrefix + name : name;
  const stars = OBJC_NO_STARS.includes(returnValue) ? '' : ' *';
  return `- (${returnValue}${stars})${prefixed}`;
}

function objcParameterTuple(rng: Rng, state: ObjCGenState): { paramString: string; paramMap: Map<string, string> } {
  const parameterList: string[] = [];
  const parameterMap = new Map<string, string>();
  const count = rng.int(1, 3);
  for (let index = 0; index < count; index += 1) {
    let type = OBJC_FUN_HEAD_LIST[rng.int(1, OBJC_FUN_HEAD_LIST.length - 1)]!;
    if (parameterMap.has(type)) type = OBJC_FUN_HEAD_LIST[rng.int(1, OBJC_FUN_HEAD_LIST.length - 1)]!;

    let name: string;
    if (parameterMap.has(type) || state.rubProMap.has(type)) {
      name = state.rubProMap.get(type) ?? parameterMap.get(type)!;
    } else if (type === 'void') {
      name = rng.word() + capitalize(rng.word());
    } else if (type.startsWith('CG')) {
      name = rng.word() + type.slice(2);
    } else {
      name = rng.word() + capitalize(rng.word());
    }

    const stars = OBJC_NO_STARS.includes(type) ? '' : ' *';
    const parameter = index === 0 ? `:(${type}${stars})${name}` : `${name}:(${type}${stars})${name}`;
    parameterList.push(parameter);
    if (!state.rubProMap.has(type)) state.rubProMap.set(type, name);
    parameterMap.set(type, name);
  }
  return { paramString: parameterList.join(' '), paramMap: parameterMap };
}

const OBJC_BORDER_STYLES: readonly string[] = [
  'UITextBorderStyleNone', 'UITextBorderStyleLine', 'UITextBorderStyleBezel', 'UITextBorderStyleRoundedRect',
];
const OBJC_CONTENT_MODES: readonly string[] = [
  'UIViewContentModeScaleToFill', 'UIViewContentModeScaleAspectFit', 'UIViewContentModeScaleAspectFill',
  'UIViewContentModeRedraw', 'UIViewContentModeCenter', 'UIViewContentModeTop', 'UIViewContentModeBottom',
  'UIViewContentModeLeft', 'UIViewContentModeRight', 'UIViewContentModeTopLeft', 'UIViewContentModeTopRight',
  'UIViewContentModeBottomLeft', 'UIViewContentModeBottomRight',
];
const OBJC_H_ALIGNMENTS: readonly string[] = [
  'UIControlContentHorizontalAlignmentCenter', 'UIControlContentHorizontalAlignmentLeft',
  'UIControlContentHorizontalAlignmentRight', 'UIControlContentHorizontalAlignmentFill',
  'UIControlContentHorizontalAlignmentLeading', 'UIControlContentHorizontalAlignmentTrailing',
];
const OBJC_V_ALIGNMENTS: readonly string[] = [
  'UIControlContentVerticalAlignmentCenter', 'UIControlContentVerticalAlignmentTop',
  'UIControlContentVerticalAlignmentBottom', 'UIControlContentVerticalAlignmentFill',
];

function objcUISegmentedControlCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.contentHorizontalAlignment = ${rng.pick(OBJC_H_ALIGNMENTS)};\n`,
    `${b}${praName}.contentVerticalAlignment = ${rng.pick(OBJC_V_ALIGNMENTS)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}//设置sc的位置大小\n${b}${praName}.frame = CGRectMake(${rng.int(0, 1000)}, ${rng.int(0, 1000)}, ${rng.int(0, 1000)}, ${rng.int(0, 1000)});\n`,
    `${b}//设置颜色\n${b}${praName}.tintColor = ${objcColor(rng)};\n`,
    `${b}//设置sc当前停留的段\n${b}${praName}.selectedSegmentIndex = 1;\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUIButtonCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.tintColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.contentHorizontalAlignment = ${rng.pick(OBJC_H_ALIGNMENTS)};\n`,
    `${b}${praName}.contentVerticalAlignment = ${rng.pick(OBJC_V_ALIGNMENTS)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}[${praName} setTitle:@"${rng.word()}${capitalize(rng.word())}" forState:UIControlStateNormal];\n`,
    `${b}[${praName} setTitleColor:${objcColor(rng)} forState:UIControlStateNormal];\n`,
    `${b}${praName}.titleLabel.font = [UIFont systemFontOfSize:${rng.int(10, 20)}];\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUISwitchCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.contentHorizontalAlignment = ${rng.pick(OBJC_H_ALIGNMENTS)};\n`,
    `${b}${praName}.contentVerticalAlignment = ${rng.pick(OBJC_V_ALIGNMENTS)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}//设置初始状态(默认状态为NO)\n${b}${praName}.on = YES;\n`,
    `${b}//设置按钮处于关闭状态时边框的颜色\n${b}${praName}.tintColor = ${objcColor(rng)};\n`,
    `${b}//设置开关处于开启时的状态\n${b}${praName}.onTintColor = ${objcColor(rng)};\n`,
    `${b}//设置开关的状态钮颜色\n${b}${praName}.thumbTintColor = ${objcColor(rng)};\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUIControlCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.contentHorizontalAlignment = ${rng.pick(OBJC_H_ALIGNMENTS)};\n`,
    `${b}${praName}.contentVerticalAlignment = ${rng.pick(OBJC_V_ALIGNMENTS)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}//设置字体颜色\n${b}${praName}.tintColor = ${objcColor(rng)};\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUIImageViewCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}//边框\n${b}${praName}.layer.borderWidth = 1;\n`,
    `${b}${praName}.layer.borderColor = ${objcColor(rng)}.CGColor;\n`,
    `${b}//裁剪\n${b}${praName}.clipsToBounds = YES;\n`,
    `${b}//缩放图片填充满UIImageView\n${b}${praName}.contentMode = UIViewContentModeScaleToFill;\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUITextFieldCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.contentHorizontalAlignment = ${rng.pick(OBJC_H_ALIGNMENTS)};\n`,
    `${b}${praName}.contentVerticalAlignment = ${rng.pick(OBJC_V_ALIGNMENTS)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}//设置占位文本\n${b}${praName}.placeholder = @"请输入文字";\n`,
    `${b}//设置文本\n${b}${praName}.text = @"${rng.word()}${capitalize(rng.word())}";\n`,
    `${b}//设置文本的颜色\n${b}${praName}.textColor = ${objcColor(rng)};\n`,
    `${b}//设置文本的字体\n${b}${praName}.font = [UIFont systemFontOfSize: ${rng.int(10, 25)} ];\n`,
    `${b}//设置文本的对齐方式\n${b}${praName}.textAlignment = NSTextAlignmentRight;\n`,
    `${b}//设置边框样式（更多边框样式到补充说明中查看）默认的样式为UITextBorderStyleNone\n${b}${praName}.borderStyle = ${rng.pick(OBJC_BORDER_STYLES)};\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUIDatePickerCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.tintColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.contentHorizontalAlignment = ${rng.pick(OBJC_H_ALIGNMENTS)};\n`,
    `${b}${praName}.contentVerticalAlignment = ${rng.pick(OBJC_V_ALIGNMENTS)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}//设置地区: zh-中国\n${b}${praName}.locale = [NSLocale localeWithLocaleIdentifier:@"zh"];\n`,
    `${b}//设置日期模式(Displays month, day, and year depending on the locale setting)\n${b}${praName}.datePickerMode = UIDatePickerModeCountDownTimer;\n`,
    `${b}// 设置当前显示时间\n${b}[${praName} setDate:[NSDate date] animated:YES];\n`,
    `${b}// 设置显示最大时间（此处为当前时间）\n${b}[${praName} setMaximumDate:[NSDate date]];\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUIPageControlCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.tintColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.contentHorizontalAlignment = ${rng.pick(OBJC_H_ALIGNMENTS)};\n`,
    `${b}${praName}.contentVerticalAlignment = ${rng.pick(OBJC_V_ALIGNMENTS)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}//设置小白点的个数\n${b}${praName}.numberOfPages = ${rng.int(0, 10)};\n`,
    `${b}//设置当前选中的点\n${b}${praName}.currentPage = 0;\n`,
    `${b}//设置当前选中的小白点的颜色\n${b}${praName}.currentPageIndicatorTintColor = ${objcColor(rng)};\n`,
    `${b}//设置未选中小白点的颜色\n${b}${praName}.pageIndicatorTintColor = ${objcColor(rng)};\n`,
    `${b}//用于控制是否只有一个页面时隐藏页面控件(默认值为NO)\n${b}${praName}.hidesForSinglePage = YES;\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUICollectionViewFlowLayoutCode(rng: Rng, layout: string): string {
  const b = '        ';
  const code = [
    `${b}//设置item的行间距和列间距\n${b}${layout}.minimumInteritemSpacing = ${rng.int(5, 20)};\n`,
    `${b}${layout}.minimumLineSpacing = ${rng.int(5, 20)};\n`,
    `${b}//设置每个分区的 上左下右 的内边距\n${b}${layout}.sectionInset = UIEdgeInsetsMake(${rng.int(0, 10)}, ${rng.int(0, 10)} ,${rng.int(0, 10)}, ${rng.int(0, 10)});\n`,
    `${b}//设置区头和区尾的大小\n${b}${layout}.headerReferenceSize = CGSizeMake([UIScreen mainScreen].bounds.size.width, ${rng.int(50, 100)});\n`,
    `${b}${layout}.footerReferenceSize = CGSizeMake([UIScreen mainScreen].bounds.size.width, ${rng.int(50, 100)});\n`,
    `${b}//设置分区的头视图和尾视图 是否始终固定在屏幕上边和下边\n${b}${layout}.sectionFootersPinToVisibleBounds = YES;\n`,
    `${b}//设置滚动条方向\n${b}${layout}.scrollDirection = UICollectionViewScrollDirectionVertical;\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUICollectionViewCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}${praName}.showsVerticalScrollIndicator = NO;   //是否显示滚动条\n`,
    `${b}${praName}.scrollEnabled = YES;  //滚动使能\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUILabelCode(rng: Rng, praName: string): string {
  const b = '    ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}//设置label的文字\n${b}${praName}.text = @"${rng.word()}${capitalize(rng.word())}";\n`,
    `${b}//设置label的字体\n${b}${praName}.font = [UIFont systemFontOfSize:${rng.int(10, 25)}];\n`,
    `${b}//设置label的颜色\n${b}${praName}.textColor = ${objcColor(rng)};\n`,
    `${b}//设置label的阴影颜色和偏移\n${b}${praName}.shadowColor = ${objcColor(rng)};\n`,
    `${b}${praName}.shadowOffset = CGSizeMake(${rng.int(10, 25)}, ${rng.int(10, 25)});\n`,
    `${b}//设置文字对齐方式\n${b}${praName}.textAlignment = NSTextAlignmentLeft;//文字居中\n`,
    `${b}//设置文案的换行模式\n${b}${praName}.lineBreakMode = NSLineBreakByTruncatingTail;//截取末尾\n`,
    `${b}//设置高亮状态相关\n${b}${praName}.highlightedTextColor = ${objcColor(rng)};\n`,
    `${b}${praName}.highlighted = YES;\n`,
    `${b}//表示显示任意行\n${b}${praName}.numberOfLines = 0;\n`,
    `${b}//设置label是否自适应字体大小\n${b}${praName}.adjustsFontSizeToFitWidth = YES;\n`,
    `${b}//设置最小缩放字体(当adjustsFontSizeToFitWidth= YES,指定了最小缩放字体）\n${b}${praName}.minimumScaleFactor = 20;\n`,
    `${b}//label截断是否紧缩文字\n${b}${praName}.allowsDefaultTighteningForTruncation = YES;\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcUISliderCode(rng: Rng, praName: string): string {
  const b = '        ';
  const code = [
    `${b}${praName}.backgroundColor = ${objcColor(rng)};\n`,
    `${b}${praName}.alpha = 0.1;\n`,
    `${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n`,
    `${b}${praName}.contentHorizontalAlignment = ${rng.pick(OBJC_H_ALIGNMENTS)};\n`,
    `${b}${praName}.contentVerticalAlignment = ${rng.pick(OBJC_V_ALIGNMENTS)};\n`,
    `${b}${praName}.tag = ${rng.int(0, 1000)};\n`,
    `${b}// minimumValue  : 当值可以改变时，滑块可以滑动到最小位置的值，默认为0.0\n${b}${praName}.minimumValue = 0.0;\n`,
    `${b}//当值可以改变时，滑块可以滑动到最大位置的值，默认为1.0\n${b}${praName}.maximumValue = 100.0;\n`,
    `${b}//当前值，这个值是介于滑块的最大值和最小值之间的，如果没有设置边界值，默认为0-1；\n${b}${praName}.value = 50;\n`,
    `${b}//小于滑块当前值滑块条的颜色\n${b}${praName}.minimumTrackTintColor = ${objcColor(rng)};\n`,
    `${b}//大于滑块当前值滑块条的颜色\n${b}${praName}.maximumTrackTintColor = ${objcColor(rng)};\n`,
    `${b}//当前滑块的颜色，默认为白色\n${b}${praName}.thumbTintColor = ${objcColor(rng)};\n`,
    `${b}// 小于滑块当前值滑块条的颜色\n${b}${praName}.minimumTrackTintColor = ${objcColor(rng)};\n`,
    `${b}//大于滑块当前值滑块条的颜色\n${b}${praName}.maximumTrackTintColor = ${objcColor(rng)};\n`,
  ];
  return rng.sample(code, PRO_COUNT).join('');
}

function objcCodeByObject(rng: Rng, praObjName: string, praName: string): string {
  const blank = '    ';
  const b = blank + blank;
  let code = '';
  if (praObjName === 'UIView') {
    code += `${blank}if(${praName} != nil){\n${b}${praName}.backgroundColor = ${objcColor(rng)};\n${b}${praName}.alpha = 0.1;\n${b}${praName}.contentMode = ${rng.pick(OBJC_CONTENT_MODES)};\n${b}${praName}.tag = ${rng.int(0, 1000)};\n${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UIButton') {
    code += `${blank}if(${praName} != nil){\n${objcUIButtonCode(rng, praName)}${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UIDatePicker') {
    code += `${blank}if(${praName} != nil){\n${objcUIDatePickerCode(rng, praName)}${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UIPageControl') {
    code += `${blank}if(${praName} != nil){\n${objcUIPageControlCode(rng, praName)}${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UISegmentedControl') {
    code += `${blank}if(${praName} != nil){\n${objcUISegmentedControlCode(rng, praName)}${blank}}else{\n${b}//创建一个数组\n${b}NSArray *${rng.word()}Array = @[@"${rng.word()}",@"${rng.word()}",@"${rng.word()}",@"${rng.word()}"];\n${b}${praName} = [[${praObjName} alloc] initWithItems:${rng.word()}Array];\n${blank}}\n`;
  } else if (praObjName === 'UITextField') {
    code += `${blank}if(${praName} != nil){\n${objcUITextFieldCode(rng, praName)}${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UISwitch') {
    code += `${blank}if(${praName} != nil){\n${objcUISwitchCode(rng, praName)}${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UISlider') {
    code += `${blank}if(${praName} != nil){\n${objcUISliderCode(rng, praName)}${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UIControl') {
    code += `${blank}if(${praName} != nil){\n${objcUIControlCode(rng, praName)}${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UIImageView') {
    code += `${blank}if(${praName} != nil){\n${objcUIImageViewCode(rng, praName)}${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UIViewController') {
    code += `${blank}if(${praName} != nil){\n${b}${praName}.view.backgroundColor = ${objcColor(rng)};\n${blank}}else{\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n`;
  } else if (praObjName === 'UICollectionView') {
    const layout = `${rng.word()}Layout`;
    code += `${blank}if(${praName} != nil){\n${objcUICollectionViewCode(rng, praName)}${blank}}else{\n${b}UICollectionViewFlowLayout *${layout} = [[UICollectionViewFlowLayout alloc] init];\n${objcUICollectionViewFlowLayoutCode(rng, layout)}${b}//${praName} 初始化\n${b}${praName} = [[${praObjName} alloc] initWithFrame:CGRectZero collectionViewLayout:${layout}];\n${blank}}\n`;
  } else if (praObjName === 'UILabel') {
    code += `${blank}if(${praName} == nil){\n${b}${praName} = [[${praObjName} alloc] init];\n${blank}}\n${objcUILabelCode(rng, praName)}`;
  } else if (praObjName === 'UIColor') {
    code += `${blank}${praName} = [UIColor colorWithRed:${rng.int(0, 255)}/255 green:${rng.int(0, 255)}/255 blue:${rng.int(0, 255)}/255 alpha:1];\n`;
  } else if (praObjName === 'UIFont') {
    code += `${blank}if(${praName} != nil){\n${b}${praName} = [UIFont systemFontOfSize:${rng.int(10, 25)}];\n${blank}}else{\n${b}//pass\n${blank}}\n`;
  } else if (praObjName === 'Void') {
    // no-op
  } else if (praObjName === 'CGFloat') {
    code += `${blank}${praName} = ${rng.int(0, 2000)}.00;\n`;
  } else if (praObjName === 'CGRect') {
    code += `${blank}${praName} = CGRectMake(${rng.int(0, 200)}, ${rng.int(0, 200)}, ${rng.int(0, 200)}, ${rng.int(0, 200)});\n`;
  } else if (praObjName === 'NSInteger') {
    code += `${blank}${praName} = ${rng.int(0, 200)};\n`;
  } else if (praObjName === 'NSString') {
    code += `${blank}${praName} = @"${rng.word()}${capitalize(rng.word())}";\n`;
  } else if (praObjName === 'NSArray') {
    code += `${blank}${praName} = @[@"${rng.word()}", @"${rng.word()}", @"${rng.word()}", @"${rng.word()}"];\n`;
  } else if (praObjName === 'NSDictionary') {
    code += `${blank}${praName} = @{@"${rng.word()}":@"${rng.word()}", @"${rng.word()}":@"${rng.word()}", @"${rng.word()}":@"${rng.word()}"};\n`;
  } else if (praObjName === 'NSNumber') {
    code += `${blank}${praName} = [NSNumber numberWithInt:${rng.int(0, 200)}];\n`;
  } else if (praObjName === 'NSURL') {
    code += `${blank}${praName} = [NSURL URLWithString:@"https://www.${rng.word()}.com/${rng.word()}/${rng.word()}"];\n`;
  } else if (praObjName === 'NSIndexPath') {
    code += `${blank}${praName} = [NSIndexPath indexPathWithIndex:${rng.int(0, 200)}];\n`;
  }
  code += '\n';
  return code;
}

function objcDetailImport(rng: Rng, state: ObjCGenState, className: string, classFunList: readonly string[], thisParamMap: ReadonlyMap<string, string>): string {
  const blank = '    ';
  const classFun = classFunList[rng.int(0, classFunList.length - 1)]!;
  const classPraName = rng.word() + capitalize(rng.word());
  let code = `${blank}${className} *${classPraName} = [[${className} alloc] init];\n`;
  let importCode = '';
  const parts = classFun.split(':');
  for (let index = 0; index < parts.length; index += 1) {
    let item = parts[index]!;
    if (item.includes(';')) item = item.replace(/;/g, '');
    if (item.includes('*')) item = item.replace(/\*/g, '');
    if (index === 0) {
      importCode += item.slice(item.indexOf(')') + 1).trim();
      continue;
    }
    const open = item.indexOf('(');
    const close = item.indexOf(')');
    const praObjName = item.slice(open + 1, close).trim();
    let praName = item.slice(close + 1).trim();
    if (praName.includes(' ')) praName = praName.split(' ')[0]!;
    if (thisParamMap.has(praObjName)) {
      importCode += index === 1 ? `:${thisParamMap.get(praObjName)}` : `${praName}:${thisParamMap.get(praObjName)}`;
    } else if (!OBJC_NO_STARS.includes(praObjName)) {
      code += `${blank}${praObjName} *${praName};\n`;
    } else {
      code += `${blank}${praObjName} ${praName};\n`;
    }
    code += objcCodeByObject(rng, praObjName, praName);
    importCode += index === 1 ? `:${praName}` : `${praName}:${praName}`;
    if (index !== parts.length - 1) importCode += ' ';
  }
  code += `${blank}[${classPraName} ${importCode}];\n`;
  if (!state.headerFiles.includes(className)) state.headerFiles.push(className);
  return code;
}

function objcImportCode(rng: Rng, state: ObjCGenState, thisParamMap: ReadonlyMap<string, string>): string {
  let code = '';
  if (state.registry.unused.size > 0) {
    const keys = [...state.registry.unused.keys()];
    const className = keys[rng.int(0, keys.length - 1)]!;
    const funList = state.registry.unused.get(className)!;
    code += objcDetailImport(rng, state, className, funList, thisParamMap);
    state.registry.unused.delete(className);
    state.registry.used.set(className, funList);
  } else if (state.registry.used.size > 0) {
    const keys = [...state.registry.used.keys()];
    const className = keys[rng.int(0, keys.length - 1)]!;
    code += objcDetailImport(rng, state, className, state.registry.used.get(className)!, thisParamMap);
  }
  code += '\n';
  return code;
}

function createObjCMethod(rng: Rng, rubPrefix: string, state: ObjCGenState): { methodCode: string; hDeclaration: string } {
  const blank = '    ';
  const returnValue = rng.pick(OBJC_FUN_HEAD_LIST);
  let returnCode: string | undefined;
  const funName = objcMethodName(rng, returnValue, rubPrefix);
  const { paramString, paramMap } = objcParameterTuple(rng, state);
  const hDeclaration = `${funName}${paramString};`;
  let methodCode = `${funName}${paramString}{\n`;
  const thisParamMap = new Map<string, string>();
  for (const [praObjName, praName] of paramMap) {
    if (praObjName === returnValue) returnCode = praName;
    methodCode += objcCodeByObject(rng, praObjName, praName);
    thisParamMap.set(praObjName, praName);
  }
  methodCode += objcImportCode(rng, state, thisParamMap);
  if (returnValue !== 'void') {
    if (returnCode !== undefined) {
      methodCode += `${blank}return ${returnCode};\n`;
    } else {
      const praName = rng.word() + capitalize(rng.word());
      if (!OBJC_NO_STARS.includes(returnValue)) methodCode += `${blank}${returnValue} *${praName};\n`;
      else methodCode += `${blank}${returnValue} ${praName};\n`;
      methodCode += objcCodeByObject(rng, returnValue, praName);
      methodCode += `${blank}return ${praName};\n`;
    }
  }
  methodCode += '}\n\n';
  return { methodCode, hDeclaration };
}

function generateObjCJunkInternal(amount: number, rubPrefix: string, seed: string, salt: string, state: ObjCGenState): ObjCJunk {
  const rng = new Rng(seed, salt);
  let hCode = '';
  let mCode = '';
  const hFunList: string[] = [];
  for (let i = 0; i < amount; i += 1) {
    const { methodCode, hDeclaration } = createObjCMethod(rng, rubPrefix, state);
    mCode += methodCode;
    hCode += `${hDeclaration}\n\n`;
    hFunList.push(hDeclaration);
  }
  for (const [praObjName, praName] of state.rubProMap) {
    let keyword = 'strong';
    let stars = '*';
    if (OBJC_ASSIGN.includes(praObjName)) { keyword = 'assign'; stars = ''; }
    else if (OBJC_COPY.includes(praObjName)) keyword = '  copy';
    hCode += `@property (nonatomic,${keyword}) ${praObjName} ${stars}${praName};\n\n`;
  }
  let headerImportCode = '';
  for (const className of state.headerFiles) headerImportCode += `#import "${className}.h"\n`;
  return { hCode, mCode, headerImportCode, hFunList };
}

/** Generate a garbage ObjC method body. */
export function generateObjCJunk(amount: number, rubPrefix: string, seed: string, salt: string): ObjCJunk {
  const state: ObjCGenState = { rubProMap: new Map(), headerFiles: [], registry: newRegistry() };
  return generateObjCJunkInternal(amount, rubPrefix, seed, salt, state);
}

/** Generate one deterministic ObjC garbage method (declaration + body). */
export function generateObjCMethod(rubPrefix: string, seed: string, salt: string): { methodCode: string; hDeclaration: string } {
  const state: ObjCGenState = { rubProMap: new Map(), headerFiles: [], registry: newRegistry() };
  const rng = new Rng(seed, salt);
  return createObjCMethod(rng, rubPrefix, state);
}

// ---------------------------------------------------------------------------
// Swift template pool.
// ---------------------------------------------------------------------------

function swiftColor(rng: Rng): string {
  return `UIColor.init(red: CGFloat(${rng.int(0, 255)}/255), green: CGFloat(${rng.int(0, 255)}/255), blue: CGFloat(${rng.int(0, 255)}/255), alpha: 1)`;
}

const SWIFT_CONTENT_MODES: readonly string[] = [
  'scaleToFill', 'scaleAspectFit', 'scaleAspectFill', 'redraw', 'center', 'top', 'bottom',
  'left', 'right', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight',
];

function swiftUIViewList(rng: Rng, praName: string, selfCode: string): string[] {
  const b = '        ';
  return [
    `${b}//设置坐标\n${b}${selfCode}${praName}.frame = CGRect(x:${rng.int(0, 99)}, y:${rng.int(0, 99)}, width:${rng.int(0, 99)}, height:${rng.int(0, 99)})\n`,
    `${b}//设置背景颜色\n${b}${selfCode}${praName}.backgroundColor = ${swiftColor(rng)}\n`,
    `${b}//将图片作为背景颜色\n${b}${selfCode}${praName}.backgroundColor = UIColor.init(patternImage: UIImage(named: "${rng.word()}Image.png")!)\n`,
    `${b}//不透明度alpha\n${b}${selfCode}${praName}.alpha = 0.${rng.int(0, 99)}\n`,
    `${b}//隐藏属性hidden\n${b}${selfCode}${praName}.isHidden = true\n`,
    `${b}//切边属性clipsToBounds\n${b}${selfCode}${praName}.clipsToBounds = true\n`,
    `${b}//是否响应用户的交互\n${b}${selfCode}${praName}.isUserInteractionEnabled = true\n`,
    `${b}//contentMode\n${b}${selfCode}${praName}.contentMode = UIView.ContentMode.${rng.pick(SWIFT_CONTENT_MODES)}\n`,
    `${b}//设置圆角\n${b}${selfCode}${praName}.layer.masksToBounds = true\n${b}${selfCode}${praName}.layer.cornerRadius = ${rng.int(5, 20)}\n`,
    `${b}//设置边框\n${b}${selfCode}${praName}.layer.borderColor = UIColor.purple.cgColor\n${b}${selfCode}${praName}.layer.borderWidth = 1.0\n`,
    `${b}//设置标志值\n${b}${selfCode}${praName}.tag = ${rng.int(0, 255)}\n`,
    `${b}//设置frame的center\n${b}${selfCode}${praName}.center = CGPoint(x: ${rng.int(0, 255)}, y: ${rng.int(0, 255)})\n`,
  ];
}

function swiftUILabelCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(
    `${b}//字体\n${b}${selfCode}${praName}.font = UIFont.systemFont(ofSize: ${rng.int(10, 30)})\n`,
    `${b}//字体颜色\n${b}${selfCode}${praName}.textColor = ${swiftColor(rng)}\n`,
    `${b}//对齐方式\n${b}${selfCode}${praName}.textAlignment = .left\n`,
    `${b}//多行显示\n${b}${selfCode}${praName}.numberOfLines = ${rng.int(0, 255)}\n`,
    `${b}//阴影\n${b}${selfCode}${praName}.shadowColor = ${swiftColor(rng)}\n${b}${selfCode}${praName}.shadowOffset = CGSize.init(width:${rng.int(0, 10)}, height:${rng.int(0, 10)})\n${b}${selfCode}${praName}.lineBreakMode = NSLineBreakMode.byTruncatingTail\n`,
    `${b}//高亮\n${b}${selfCode}${praName}.isHighlighted = true\n${b}${selfCode}${praName}.highlightedTextColor = ${swiftColor(rng)}\n`,
    `${b}//文字过长时省略方式\n${b}${selfCode}${praName}.lineBreakMode = .byTruncatingTail\n`,
    `${b}//当文字超出标签宽度时，自动调整文字大小，使其不被截断\n${b}${selfCode}${praName}.adjustsFontSizeToFitWidth = true\n`,
  );
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUICollectionViewCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(`${b}${selfCode}${praName}.showsVerticalScrollIndicator = false\n`);
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUIViewControllerCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  return rng.sample([`${b}//设置背景颜色\n${b}${selfCode}${praName}.view.backgroundColor = ${swiftColor(rng)}\n`], 1).join('');
}

function swiftUIImageViewCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(`${b}//设置显示的图片\n${b}${selfCode}${praName}.image = UIImage(named: "${rng.word()}Image.png")\n`);
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUIControlCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(`${b}//设置关闭状态的颜色\n${b}${selfCode}${praName}.tintColor = ${swiftColor(rng)}\n`);
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUISliderCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(
    `${b}//最小值\n${b}${selfCode}${praName}.minimumValue = 0\n`,
    `${b}//最大值\n${b}${selfCode}${praName}.maximumValue = 1\n`,
    `${b}//当前值\n${b}${selfCode}${praName}.value = 0.5\n`,
    `${b}//左边槽的颜色\n${b}${selfCode}${praName}.minimumTrackTintColor = ${swiftColor(rng)}\n`,
    `${b}//右边槽的颜色\n${b}${selfCode}${praName}.maximumTrackTintColor = ${swiftColor(rng)}\n`,
    `${b}//左边图标\n${b}${selfCode}${praName}.minimumValueImage = UIImage(named:"${rng.word()}Image.png")\n`,
    `${b}//右边图标\n${b}${selfCode}${praName}.maximumValueImage = UIImage(named:"${rng.word()}Image.png")\n`,
  );
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUISwitchCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(
    `${b}//设置开启状态显示的颜色\n${b}${selfCode}${praName}.onTintColor = ${swiftColor(rng)}\n`,
    `${b}//设置关闭状态的颜色\n${b}${selfCode}${praName}.tintColor = ${swiftColor(rng)}\n`,
    `${b}//滑块上小圆点的颜色\n${b}${selfCode}${praName}.thumbTintColor = ${swiftColor(rng)}\n`,
  );
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUITextFieldCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(
    `${b}//设置边框样式为圆角矩形\n${b}${selfCode}${praName}.borderStyle = UITextField.BorderStyle.roundedRect\n`,
    `${b}//字体颜色\n${b}${selfCode}${praName}.textColor = ${swiftColor(rng)}\n`,
    `${b}//字体\n${b}${selfCode}${praName}.font = UIFont.systemFont(ofSize: ${rng.int(10, 30)})\n`,
    `${b}${selfCode}${praName}.textAlignment = NSTextAlignment.left\n`,
    `${b}//文本框提示文字\n${b}${selfCode}${praName}.placeholder = "请输入文字"\n`,
    `${b}//明文显示\n${b}${selfCode}${praName}.isSecureTextEntry = false\n`,
    `${b}//光标颜色\n${b}${selfCode}${praName}.tintColor = ${swiftColor(rng)}\n`,
    `${b}//当文字超出文本框宽度时，自动调整文字大小\n${b}${selfCode}${praName}.adjustsFontSizeToFitWidth = true\n`,
    `${b}//最小可缩小的字号\n${b}${selfCode}${praName}.minimumFontSize = ${rng.int(10, 20)}\n`,
    `${b}//清除按钮（输入框内右侧小叉）\n${b}${selfCode}${praName}.clearButtonMode = .whileEditing\n`,
    `${b}//设置文本框关联的键盘类型\n${b}${selfCode}${praName}.keyboardType = .default\n`,
    `${b}//设置键盘return键的样式\n${b}${selfCode}${praName}.returnKeyType = .send\n`,
  );
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUISegmentedControlCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(
    `${b}//默认第0个选中\n${b}${selfCode}${praName}.selectedSegmentIndex = 0\n`,
    `${b}//点击之后是否属于选中状态(true:否)\n${b}${selfCode}${praName}.isMomentary = true\n`,
  );
  const sizeName = rng.word();
  code.push(`${b}//修改item内容的偏移量\n${b}let ${sizeName} = CGSize(width: -${rng.int(0, 20)}, height: -${rng.int(0, 20)})\n${b}${selfCode}${praName}.setContentOffset(${sizeName}, forSegmentAt: 0)\n`);
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUIPageControlCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(
    `${b}//设置总页数\n${b}${selfCode}${praName}.numberOfPages = ${rng.int(0, 30)}\n`,
    `${b}//设置未选中颜色\n${b}${selfCode}${praName}.pageIndicatorTintColor = ${swiftColor(rng)}\n`,
    `${b}//当前多少页\n${b}${selfCode}${praName}.currentPage = 0\n`,
    `${b}//选中滑块的颜色\n${b}${selfCode}${praName}.currentPageIndicatorTintColor = ${swiftColor(rng)}\n`,
  );
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUIDatePickerCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(
    `${b}//设置datePickerMode\n${b}${selfCode}${praName}.datePickerMode = UIDatePicker.Mode.date\n`,
    `${b}//获取当前本地化\n${b}${selfCode}${praName}.locale = Locale.init(identifier: "zh_CN")\n`,
    `${b}//设置日历属性\n${b}${selfCode}${praName}.calendar = Calendar.current\n`,
    `${b}//时区的设置\n${b}${selfCode}${praName}.timeZone = TimeZone.current\n`,
    `${b}//日期属性\n${b}${selfCode}${praName}.date = Date.init(timeIntervalSinceNow: ${rng.int(0, 255)})\n`,
    `${b}//设置一个时间区段\n${b}${selfCode}${praName}.date = Date.init(timeIntervalSinceNow: ${rng.int(0, 255)})\n`,
    `${b}//时间间隔属性\n${b}${selfCode}${praName}.minuteInterval = ${rng.int(0, 255)}\n`,
  );
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUIButtonCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  const code = swiftUIViewList(rng, praName, selfCode);
  code.push(
    `${b}//设置title\n${b}${selfCode}${praName}.setTitle("${rng.wordTitle()}", for: .normal)\n`,
    `${b}//设置title颜色\n${b}${selfCode}${praName}.setTitleColor(${swiftColor(rng)}, for: .normal)\n`,
    `${b}//字体\n${b}${selfCode}${praName}.titleLabel?.font = UIFont.systemFont(ofSize: ${rng.int(10, 30)})\n`,
  );
  return rng.sample(code, PRO_COUNT).join('');
}

function swiftUIViewCode(rng: Rng, praName: string, selfCode: string): string {
  return rng.sample(swiftUIViewList(rng, praName, selfCode), PRO_COUNT).join('');
}

function swiftUIFontCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  return rng.sample([`${b}${selfCode}${praName} = UIFont.systemFont(ofSize: ${rng.int(10, 30)})\n`], 1).join('');
}

function swiftUIColorCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  return rng.sample([`${b}${selfCode}${praName} = UIColor.init(red: CGFloat(${rng.int(0, 255)}/255), green: CGFloat(${rng.int(0, 255)}/255), blue: CGFloat(${rng.int(0, 255)}/255), alpha: 1)\n`], 1).join('');
}

function swiftNSArrayCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  return `${b}${selfCode}${praName} = ["${rng.word()}", "${rng.word()}", "${rng.word()}"]\n`;
}

function swiftNSDictionaryCode(rng: Rng, praName: string, selfCode: string): string {
  const b = '        ';
  return `${b}${selfCode}${praName} = ["${rng.word()}": "${rng.word()}", "${rng.word()}": "${rng.word()}"]\n`;
}

function swiftCodeByObject(
  rng: Rng,
  state: SwiftGenState,
  praObjName: string,
  praName: string,
  spaceCount: number,
  isNeedInit = false,
): string {
  const selfCode = state.rubProMap.has(praObjName) && state.rubProMap.get(praObjName) === praName ? 'self.' : '';
  const blank = ' '.repeat(spaceCount);
  const b = blank + blank;
  let code = '';
  const letStr = SWIFT_VAR_LIST.includes(praObjName) ? 'var' : 'let';
  if (isNeedInit) code += `${b}${letStr} ${praName} = ${praObjName}()\n`;

  if (praObjName === 'UIView') code += swiftUIViewCode(rng, praName, selfCode);
  else if (praObjName === 'UIButton') code += swiftUIButtonCode(rng, praName, selfCode);
  else if (praObjName === 'UIDatePicker') code += swiftUIDatePickerCode(rng, praName, selfCode);
  else if (praObjName === 'UIPageControl') code += swiftUIPageControlCode(rng, praName, selfCode);
  else if (praObjName === 'UISegmentedControl') code += swiftUISegmentedControlCode(rng, praName, selfCode);
  else if (praObjName === 'UITextField') code += swiftUITextFieldCode(rng, praName, selfCode);
  else if (praObjName === 'UISwitch') code += swiftUISwitchCode(rng, praName, selfCode);
  else if (praObjName === 'UISlider') code += swiftUISliderCode(rng, praName, selfCode);
  else if (praObjName === 'UIControl') code += swiftUIControlCode(rng, praName, selfCode);
  else if (praObjName === 'UIImageView') code += swiftUIImageViewCode(rng, praName, selfCode);
  else if (praObjName === 'UIViewController') code += swiftUIViewControllerCode(rng, praName, selfCode);
  else if (praObjName === 'UICollectionView') code += swiftUICollectionViewCode(rng, praName, selfCode);
  else if (praObjName === 'UILabel') code += swiftUILabelCode(rng, praName, selfCode);
  else if (praObjName === 'UIColor') code += swiftUIColorCode(rng, praName, selfCode);
  else if (praObjName === 'UIFont') code += swiftUIFontCode(rng, praName, selfCode);
  else if (praObjName === 'Void') { /* no-op */ }
  else if (praObjName === 'CGFloat') code += `${b}${selfCode}${praName} = ${rng.int(0, 2000)}.00\n`;
  else if (praObjName === 'CGRect') code += `${b}${selfCode}${praName} = CGRect(x: ${rng.int(10, 200)}, y: ${rng.int(10, 200)}, width: ${rng.int(10, 200)}, height: ${rng.int(10, 200)})\n`;
  else if (praObjName === 'NSInteger') code += `${b}${selfCode}${praName} = ${rng.int(0, 2000)}\n`;
  else if (praObjName === 'NSString' || praObjName === 'String') code += `${b}${selfCode}${praName} = "${rng.word()}${capitalize(rng.word())}"\n`;
  else if (praObjName === 'NSArray' || praObjName === 'Array') code += swiftNSArrayCode(rng, praName, selfCode);
  else if (praObjName === 'NSDictionary') code += swiftNSDictionaryCode(rng, praName, selfCode);
  else if (praObjName === 'NSURL') code += `${b}${selfCode}${praName} = NSURL(string: "https://www.${rng.word()}.com/${rng.word()}")!\n`;
  return code;
}

function swiftMethodName(rng: Rng, returnValue: string, parameterStr: string, rubPrefix: string): string {
  let suffix: string;
  if (returnValue === 'Void' || returnValue === 'void') suffix = 'Fun';
  else if (returnValue.startsWith('CG')) suffix = returnValue.slice(2);
  else suffix = '';
  const name = rng.int(0, 1) === 0
    ? rng.word() + capitalize(rng.word()) + suffix
    : rng.word() + capitalize(rng.word()) + capitalize(rng.word()) + suffix;
  const prefixed = rubPrefix.length > 0 ? rubPrefix + name : name;
  return `func ${prefixed}${parameterStr} -> ${returnValue}`;
}

function swiftParameterTuple(rng: Rng, state: SwiftGenState): { paramString: string; paramMap: Map<string, string> } {
  const parameterList: string[] = [];
  const parameterMap = new Map<string, string>();
  const count = rng.int(1, 3);
  for (let index = 0; index < count; index += 1) {
    let type = SWIFT_FUN_HEAD_LIST[rng.int(1, SWIFT_FUN_HEAD_LIST.length - 1)]!;
    if (parameterMap.has(type)) type = SWIFT_FUN_HEAD_LIST[rng.int(1, SWIFT_FUN_HEAD_LIST.length - 1)]!;

    let name: string;
    if (parameterMap.has(type) || state.rubProMap.has(type)) {
      name = state.rubProMap.get(type) ?? parameterMap.get(type)!;
    } else if (type === 'void' || type === 'Void') {
      name = rng.word() + capitalize(rng.word());
    } else if (type.startsWith('CG')) {
      name = rng.word() + type.slice(2);
    } else {
      name = rng.word() + capitalize(rng.word());
    }

    parameterList.push(index === 0 ? `_ ${name}: ${type}` : ` ${name}: ${type}`);
    if (!state.rubProMap.has(type)) state.rubProMap.set(type, name);
    parameterMap.set(type, name);
  }
  return { paramString: `(${parameterList.join(',')})`, paramMap: parameterMap };
}

function swiftDetailImport(rng: Rng, state: SwiftGenState, className: string, classFunList: readonly string[], thisParamMap: ReadonlyMap<string, string>): string {
  const blank = '        ';
  const classFun = classFunList[rng.int(0, classFunList.length - 1)]!;
  if (!classFun.startsWith('func ')) return `${blank}// 无效的引用\n`;
  const classPraName = rng.wordTitle();
  let code = `${blank}let ${classPraName} = ${className}()\n`;
  const openParen = classFun.indexOf('(');
  const closeParen = classFun.indexOf(')');
  const main = classFun.slice(classFun.indexOf('func ') + 5, openParen);
  let importCode = `.${main}(`;
  let paramStr = classFun.slice(openParen + 1, closeParen);
  if (paramStr.startsWith('_ ')) paramStr = paramStr.slice(2);
  const parts = paramStr.split(',');
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index]!.replace(/\s/g, '');
    const [praName, praObjName] = item.split(':') as [string, string];
    if (thisParamMap.has(praObjName)) {
      importCode += index === 0 ? `${thisParamMap.get(praObjName)},` : `${praName}: ${thisParamMap.get(praObjName)},`;
      continue;
    }
    code += swiftCodeByObject(rng, state, praObjName, praName, 4, true);
    importCode += index === 0 ? `${praName},` : `${praName}: ${praName},`;
  }
  if (importCode.endsWith(',')) importCode = importCode.slice(0, -1);
  importCode += ')';
  code += `${blank}${classPraName}${importCode}\n`;
  return code;
}

function swiftImportCode(rng: Rng, state: SwiftGenState, thisParamMap: ReadonlyMap<string, string>): string {
  let code = '';
  if (state.registry.unused.size > 0) {
    const keys = [...state.registry.unused.keys()];
    const className = keys[rng.int(0, keys.length - 1)]!;
    const funList = state.registry.unused.get(className)!;
    code += swiftDetailImport(rng, state, className, funList, thisParamMap);
    state.registry.unused.delete(className);
    state.registry.used.set(className, funList);
  } else if (state.registry.used.size > 0) {
    const keys = [...state.registry.used.keys()];
    const className = keys[rng.int(0, keys.length - 1)]!;
    code += swiftDetailImport(rng, state, className, state.registry.used.get(className)!, thisParamMap);
  }
  code += '\n';
  return code;
}

function createSwiftMethod(rng: Rng, rubPrefix: string, state: SwiftGenState): { methodCode: string; declaration: string } {
  const blank = '    ';
  const returnValue = rng.pick(SWIFT_FUN_HEAD_LIST);
  let returnCode: string | undefined;
  const { paramString, paramMap } = swiftParameterTuple(rng, state);
  const declaration = swiftMethodName(rng, returnValue, paramString, rubPrefix);
  let methodCode = `${blank}${declaration}{\n`;
  const thisParamMap = new Map<string, string>();
  for (const [praObjName, praName] of paramMap) {
    if (praObjName === returnValue) returnCode = praName;
    methodCode += `${swiftCodeByObject(rng, state, praObjName, praName, 4)}\n`;
    thisParamMap.set(praObjName, praName);
  }
  methodCode += swiftImportCode(rng, state, thisParamMap);
  if (returnValue === 'Void' || returnValue === 'void') {
    methodCode += `${blank}${blank}//\n`;
  } else if (returnCode !== undefined) {
    methodCode += `${blank}${blank}return ${returnCode}\n`;
  } else {
    const letStr = SWIFT_VAR_LIST.includes(returnValue) ? 'var' : 'let';
    const praName = rng.word() + capitalize(rng.word());
    methodCode += `${blank}${blank}${letStr} ${praName} = ${returnValue}()\n`;
    methodCode += `${swiftCodeByObject(rng, state, returnValue, praName, 4)}\n`;
    methodCode += `${blank}${blank}return ${praName}\n`;
  }
  methodCode += `${blank}}\n\n`;
  return { methodCode, declaration };
}

function swiftLazyProperty(rng: Rng, praName: string, praObjName: string): string {
  const blank = '    ';
  if (praObjName === 'Bool') {
    const nowDateStr = `${rng.word()}Date`;
    const timeIntervalStr = `${rng.word()}Interval`;
    const timeStampStr = `timeStamp${rng.wordTitle()}`;
    return `${blank}var ${praName}: Bool {\n`
      + `${blank}${blank}let ${nowDateStr} = NSDate()\n`
      + `${blank}${blank}let ${timeIntervalStr}: TimeInterval = ${nowDateStr}.timeIntervalSince1970\n`
      + `${blank}${blank}let ${timeStampStr} = Int(${timeIntervalStr})\n`
      + `${blank}${blank}if (${timeStampStr}/2 == 0){\n`
      + `${blank}${blank}${blank}return true\n`
      + `${blank}${blank}}else{\n`
      + `${blank}${blank}${blank}return false\n`
      + `${blank}${blank}}\n`
      + `${blank}}\n`;
  }
  if (praObjName === 'CGFloat') return `${blank}var ${praName}: CGFloat! = 0.0\n`;
  if (praObjName === 'CGRect') {
    return `${blank}var ${praName}: CGRect = CGRect(x: ${rng.int(30, 300)}, y: ${rng.int(30, 300)}, width: ${rng.int(30, 300)}, height: ${rng.int(30, 300)})\n`;
  }
  if (praObjName === 'NSInteger') return `${blank}var ${praName}: NSInteger! = 0\n`;
  if (praObjName === 'NSString') return `${blank}var ${praName}: NSString! = ""\n`;
  if (praObjName === 'NSArray') return `${blank}var ${praName}: NSArray! = []\n`;
  if (praObjName === 'NSDictionary') return `${blank}var ${praName}: NSDictionary = [String:String]() as NSDictionary\n`;
  if (praObjName === 'NSNumber') return `${blank}var ${praName}: NSNumber = 0\n`;
  if (praObjName === 'NSURL') {
    const address = `"https://www.${rng.word()}${rng.word()}.com"`;
    return `${blank}var ${praName}: NSURL = NSURL(string: ${address} as String)!\n`;
  }
  return `${blank}var ${praName}: ${praObjName} = ${praObjName}()\n`;
}

function generateSwiftJunkInternal(amount: number, rubPrefix: string, seed: string, salt: string, state: SwiftGenState): SwiftJunk {
  const rng = new Rng(seed, salt);
  let methodCode = '';
  const funList: string[] = [];
  for (let i = 0; i < amount; i += 1) {
    const { methodCode: body, declaration } = createSwiftMethod(rng, rubPrefix, state);
    methodCode += body;
    funList.push(declaration);
  }
  let propertyCode = '';
  for (const [praObjName, praName] of state.rubProMap) propertyCode += swiftLazyProperty(rng, praName, praObjName);
  return { propertyCode, methodCode, funList };
}

/** Generate a garbage Swift method body. */
export function generateSwiftJunk(amount: number, rubPrefix: string, seed: string, salt: string): SwiftJunk {
  const state: SwiftGenState = { rubProMap: new Map(), registry: newRegistry() };
  return generateSwiftJunkInternal(amount, rubPrefix, seed, salt, state);
}

/** Generate one deterministic Swift garbage method. */
export function generateSwiftMethod(rubPrefix: string, seed: string, salt: string): { methodCode: string; declaration: string } {
  const state: SwiftGenState = { rubProMap: new Map(), registry: newRegistry() };
  const rng = new Rng(seed, salt);
  return createSwiftMethod(rng, rubPrefix, state);
}

// ---------------------------------------------------------------------------
// File head template.
// ---------------------------------------------------------------------------

/** Deterministic port of getHeadCode (Xcode source-file header comment). */
export function generateFileHead(fileName: string, seed: string, salt: string): string {
  const rng = new Rng(seed, `${salt}:head`);
  const line1 = rng.wordUpper();
  const line2 = rng.wordUpper();
  const line3 = rng.wordUpper();
  const date = dateString(rng);
  return `//\n//  ${fileName}\n//  ${line1}\n//\n//  Created by ${line2} on ${date}.\n//  Copyright © 2019 ${line3}. All rights reserved.\n//\n\n\n`;
}

const OBJC_IMPORT_LIST: readonly string[] = [
  '#import <Foundation/Foundation.h>\n#import <UIKit/UIKit.h>',
  '#import <UIKit/UIKit.h>',
  '#import <UIKit/UIKit.h>',
];

/** Build one OC `.h`/`.m` file pair from an ObjCJunk tuple. */
export function generateObjCFile(objectName: string, objClass: ObjCSuperclass, junk: ObjCJunk, seed: string, salt: string): { h: string; m: string } {
  const h = generateFileHead(`${objectName}.h`, seed, salt)
    + `${OBJC_IMPORT_LIST[SPORT_OBJ_LIST.indexOf(objClass)]!}\n\n`
    + `@interface ${objectName} : ${objClass}\n\n`
    + junk.hCode
    + '\n@end\n';
  let m = generateFileHead(`${objectName}.m`, seed, salt)
    + `#import "${objectName}.h"\n`
    + junk.headerImportCode
    + '\n'
    + `@interface ${objectName} ()\n\n@end\n\n`
    + `@implementation ${objectName}\n\n`;
  if (objClass === 'UIViewController') {
    m += '- (void)viewDidLoad {\n    [super viewDidLoad];\n    // Do any additional setup after loading the view from its nib.\n}\n\n';
  }
  m += junk.mCode + '@end\n';
  return { h, m };
}

/** Build one Swift file from a SwiftJunk tuple. */
export function generateSwiftFile(objectName: string, objClass: SwiftSuperclass, junk: SwiftJunk, seed: string, salt: string): string {
  let code = generateFileHead(`${objectName}.swift`, seed, salt)
    + 'import Foundation\nimport UIKit\n\n'
    + `class ${objectName}: ${objClass} {\n\n`
    + junk.propertyCode
    + '\n\n';
  if (objClass === 'UIViewController') {
    code += '    override func viewDidLoad() {\n        super.viewDidLoad()\n    }\n';
  }
  code += '\n' + junk.methodCode + '}\n';
  return code;
}

// ---------------------------------------------------------------------------
// Ignorable-path predicate.
// ---------------------------------------------------------------------------

const IGNORED_SUBSTRINGS: readonly string[] = [
  '/Pods/', '/.git/', '/Podfile', '/Podfile.lock', '/README.md', '/AppDelegate.', '/SceneDelegate.',
  '/.DS_Store', '/UserInterfaceState.xcuserstate', '/.svn/',
];

/** True for paths that must be skipped (never obfuscated). */
export function isIgnoredPath(relativePath: string): boolean {
  if (relativePath.includes('.framework')) return true;
  if (relativePath.includes('+')) return true;
  const normalized = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return IGNORED_SUBSTRINGS.some(part => normalized.includes(part));
}

// ---------------------------------------------------------------------------
// Insertion transforms.
// ---------------------------------------------------------------------------

function classInterfacePattern(objectName: string): RegExp {
  return new RegExp(`@interface\\s+${objectName}(?:\\s|:|\\()`);
}

/** Insert ObjC junk declarations before the matching `@interface`'s `@end`. */
export function insertObjCHeaderJunk(content: string, objectName: string, hCode: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let importedUIKit = lines.some(line => line.includes('<UIKit/UIKit.h>'));
  let didImport = false;
  let isPassInterface = false;
  let added = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (!didImport && (line.includes('#import') || line.includes('#include'))) {
      out.push(line);
      if (!importedUIKit) {
        out.push('#import <UIKit/UIKit.h>');
        out.push('');
        importedUIKit = true;
      }
      didImport = true;
      continue;
    }
    if (line.includes('@interface') && !line.includes('//@interface') && classInterfacePattern(objectName).test(line)) {
      isPassInterface = true;
    }
    if (stripped === '@end' && !line.includes('//@end') && !added && isPassInterface) {
      added = true;
      out.push('');
      out.push(hCode);
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Insert ObjC junk method bodies before the matching `@implementation`'s `@end`. */
export function insertObjCImplJunk(content: string, objectName: string, mCode: string, headerImportCode: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let isLastEnd = false;
  let addedImport = false;
  for (const line of lines) {
    const stripped = line.replace(/\s/g, '');
    if (stripped.includes('@interface') && !line.includes('//@interface')) isLastEnd = false;
    if (stripped.includes('@implementation') && !line.includes('//@implementation') && line.includes(`@implementation ${objectName}`)) isLastEnd = true;
    if ((stripped.includes('#import') || stripped.includes('#include')) && !addedImport) {
      out.push(line);
      if (headerImportCode.length > 0) out.push(headerImportCode.replace(/\n$/, ''));
      addedImport = true;
      continue;
    }
    if (stripped === '@end' && isLastEnd) {
      out.push('');
      out.push(mCode);
      out.push('');
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Insert Swift junk properties + methods right after the class/struct/extension opening brace. */
export function insertSwiftJunk(content: string, objectName: string, propertyCode: string, methodCode: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let count = 0;
  let addedPro = false;
  let addedRun = false;
  for (let line of lines) {
    const stripped = line.replace(/\s/g, '');
    const isClassLine = stripped.includes(`class${objectName}:`)
      || stripped.includes(`extension${objectName}`)
      || stripped.includes(`struct${objectName}{`)
      || stripped.includes(`class${objectName}{`);
    if (isClassLine && !addedPro) count += 1;
    if (line.includes('{') && !addedPro && count === 1) count += 1;
    if (count === 2 && !addedPro) {
      line += propertyCode;
      line += '\n';
      addedPro = true;
    }
    if (addedPro && !addedRun) {
      line += methodCode;
      addedRun = true;
    }
    out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// pbxproj registration.
// ---------------------------------------------------------------------------

interface PbxSnippets {
  folderRef: string;
  folderBlock: string;
  fileRefs: string[];
  sources: string[];
  buildFiles: string[];
}

function registerInPbxproj(content: string, snippets: PbxSnippets): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inGroup = false;
  let inSources = false;
  let addedFolderRef = false;
  let addedSources = false;
  for (const line of lines) {
    if (line.includes('/* Begin PBXGroup section */')) inGroup = true;
    if (line.includes('/* End PBXGroup section */')) inGroup = false;
    if (line.includes('/* Begin PBXSourcesBuildPhase section */')) inSources = true;
    if (line.includes('/* End PBXSourcesBuildPhase section */')) inSources = false;

    if (inGroup && !addedFolderRef && line.includes('children = (')) {
      out.push(line);
      out.push(`                ${snippets.folderRef}`);
      addedFolderRef = true;
      continue;
    }
    if (inSources && !addedSources && line.includes('files = (')) {
      out.push(line);
      for (const item of snippets.sources) out.push(`                ${item.trimEnd()}`);
      addedSources = true;
      continue;
    }
    if (line.includes('/* End PBXGroup section */')) {
      out.push(snippets.folderBlock.trimEnd());
      out.push(line);
      continue;
    }
    if (line.includes('/* End PBXFileReference section */')) {
      for (const item of snippets.fileRefs) out.push(`\t\t${item.trimEnd()}`);
      out.push(line);
      continue;
    }
    if (line.includes('/* End PBXBuildFile section */')) {
      for (const item of snippets.buildFiles) out.push(`\t\t${item.trimEnd()}`);
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Resource detection + cleanup.
// ---------------------------------------------------------------------------

const RESOURCE_CLEAN_EXTENSIONS: readonly string[] = ['.jpg', '.bmp', '.png', '.jpeg', '.rgb', '.tif', '.gif', '.mp3', '.mp4', '.caf'];

const CODE_SEARCH_EXTENSIONS: ReadonlySet<string> = new Set(['h', 'm', 'mm', 'swift', 'c', 'cpp', 'cc', 'hpp', 'java', 'kt', 'dart', 'js', 'ts', 'jsx', 'tsx']);
const TEXT_SEARCH_EXTENSIONS: ReadonlySet<string> = new Set(['json', 'plist', 'strings', 'xml', 'storyboard', 'xib', 'html', 'htm', 'txt', 'md', 'csv', 'tsv', 'yml', 'yaml', 'css', 'scss', 'less']);

function basenameOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1]!;
}

/** True for loose resource files (not imagesets), mirroring `isResource`. */
export function isResourcePath(relativePath: string): boolean {
  const base = basenameOf(relativePath);
  return RESOURCE_CLEAN_EXTENSIONS.some(ext => base.endsWith(ext));
}

/** Resource name (basename up to the first dot), mirroring `searchAllResName`. */
export function resourceNameFromPath(relativePath: string): string {
  return basenameOf(relativePath).split('.')[0]!;
}

function imagesetDirOf(absolutePath: string): string | undefined {
  let dir = dirname(absolutePath);
  for (;;) {
    if (basenameOf(dir).endsWith('.imageset')) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function imagesetRelative(relativePath: string): string {
  const parts = relativePath.split('/');
  const index = parts.findIndex(part => part.endsWith('.imageset'));
  return parts.slice(0, index + 1).join('/');
}

/** Names referenced by a single code line, mirroring `findResNameAtFileLine`. */
export function lineReferencesResource(line: string, resourceNames: ReadonlySet<string>): string[] {
  const refs: string[] = [];
  for (const raw of line.split('"')) {
    let item = raw;
    if (item.includes('.')) item = item.split('.')[0]!;
    if (resourceNames.has(item)) refs.push(item);
    else if (resourceNames.has(`${item}@1x`)) refs.push(`${item}@1x`);
    else if (resourceNames.has(`${item}@2x`)) refs.push(`${item}@2x`);
    else if (resourceNames.has(`${item}@3x`)) refs.push(`${item}@3x`);
  }
  return refs;
}

function isSearchCarrier(relativePath: string): boolean {
  const ext = extension(relativePath);
  return CODE_SEARCH_EXTENSIONS.has(ext) || TEXT_SEARCH_EXTENSIONS.has(ext);
}

function cleanPbxproj(content: string, unusedNames: ReadonlySet<string>): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    let drop = false;
    for (const name of unusedNames) {
      if (line.includes(name)) { drop = true; break; }
    }
    if (!drop) kept.push(line);
  }
  return kept.join('\n');
}

// ---------------------------------------------------------------------------
// Batch functions.
// ---------------------------------------------------------------------------

/**
 * Inject deterministic ObjC/Swift garbage methods into eligible source files.
 * Matched `.h`/`.m`/`.mm` pairs share one generated junk tuple (so declarations
 * and implementations stay in sync); `.swift` files get lazy properties + methods.
 */
export function insertJunkCode(files: readonly WalkEntry[], options: JunkCodeOptions, seed: string): TransformOutcome {
  const amount = Math.max(1, options.amount ?? 1);
  const rubPrefix = options.rubPrefix ?? DEFAULT_RUB_PREFIX;
  const eligible = files.filter(file => {
    const ext = extension(file.relative);
    return (ext === 'h' || ext === 'm' || ext === 'mm' || ext === 'swift') && !isIgnoredPath(file.relative);
  });

  const byStem = new Map<string, WalkEntry[]>();
  for (const file of eligible) {
    const stem = basenameWithoutExtension(file.relative);
    const list = byStem.get(stem) ?? [];
    list.push(file);
    byStem.set(stem, list);
  }

  const registry = newRegistry();
  const changedPaths: string[] = [];
  let changed = 0;

  for (const stem of [...byStem.keys()].sort()) {
    const entries = byStem.get(stem)!;
    if (entries.some(entry => extension(entry.relative) === 'swift')) {
      const state: SwiftGenState = { rubProMap: new Map(), registry };
      const junk = generateSwiftJunkInternal(amount, rubPrefix, seed, stem, state);
      registry.unused.set(stem, junk.funList);
      for (const entry of entries) {
        if (extension(entry.relative) !== 'swift') continue;
        const next = insertSwiftJunk(readFileSync(entry.absolute, 'utf8'), stem, junk.propertyCode, junk.methodCode);
        if (writeIfChanged(entry, next)) { changed += 1; changedPaths.push(entry.relative); }
      }
    } else {
      const state: ObjCGenState = { rubProMap: new Map(), headerFiles: [], registry };
      const junk = generateObjCJunkInternal(amount, rubPrefix, seed, stem, state);
      registry.unused.set(stem, junk.hFunList);
      for (const entry of entries) {
        const ext = extension(entry.relative);
        const content = readFileSync(entry.absolute, 'utf8');
        const next = ext === 'h'
          ? insertObjCHeaderJunk(content, stem, junk.hCode)
          : insertObjCImplJunk(content, stem, junk.mCode, junk.headerImportCode);
        if (writeIfChanged(entry, next)) { changed += 1; changedPaths.push(entry.relative); }
      }
    }
  }

  return { changed, changedPaths };
}

/**
 * Create deterministic garbage `.h`/`.m`/`.swift` files under a generated folder
 * and register them into the project's `project.pbxproj`.
 */
export function createJunkFiles(root: string, files: readonly WalkEntry[], options: JunkFileOptions, seed: string): TransformOutcome {
  const count = Math.max(1, options.count ?? 1);
  const amount = Math.max(1, options.amount ?? 1);
  const rubPrefix = options.rubPrefix ?? DEFAULT_RUB_PREFIX;
  const language = options.language ?? 'OC';
  const pbx = files.find(file => file.relative.endsWith('project.pbxproj'));

  const rng = new Rng(seed, 'junk-files');
  const folderName = rng.wordTitle() + rng.wordTitle();
  const folderUdid = deriveUuid(seed, `folder:${folderName}`);
  const folderAbsolute = join(root, folderName);
  mkdirSync(folderAbsolute, { recursive: true });

  const changedPaths: string[] = [];
  let changed = 0;
  const children: string[] = [];
  const fileRefs: string[] = [];
  const sources: string[] = [];
  const buildFiles: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const salt = `file:${index}`;
    const objClass = SPORT_OBJ_LIST[rng.int(0, 2)] as ObjCSuperclass;

    if (language === 'Swift') {
      const objectName = objcGetMissObjName(objClass, seed, `${salt}:name`);
      const junk = generateSwiftJunk(amount, rubPrefix, seed, `${salt}:code`);
      const fileContent = generateSwiftFile(objectName, objClass, junk, seed, salt);
      writeFileSync(join(folderAbsolute, `${objectName}.swift`), fileContent);
      changed += 1;
      changedPaths.push(`${folderName}/${objectName}.swift`);
      const udid = deriveUuid(seed, `${objectName}.swift:ref`);
      const buildUdid = deriveUuid(seed, `${objectName}.swift:build`);
      children.push(`${udid} /* ${objectName}.swift */,`);
      fileRefs.push(`${udid} /* ${objectName}.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${objectName}.swift; sourceTree = "<group>"; };\n`);
      sources.push(`${buildUdid} /* ${objectName}.swift in Sources */,\n`);
      buildFiles.push(`${buildUdid} /* ${objectName}.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${udid} /* ${objectName}.swift */; };\n`);
    } else {
      const objectName = objcGetMissObjName(objClass, seed, `${salt}:name`);
      const junk = generateObjCJunk(amount, rubPrefix, seed, `${salt}:code`);
      const { h, m } = generateObjCFile(objectName, objClass, junk, seed, salt);
      writeFileSync(join(folderAbsolute, `${objectName}.h`), h);
      writeFileSync(join(folderAbsolute, `${objectName}.m`), m);
      changed += 2;
      changedPaths.push(`${folderName}/${objectName}.h`, `${folderName}/${objectName}.m`);
      const hUdid = deriveUuid(seed, `${objectName}.h:ref`);
      const mUdid = deriveUuid(seed, `${objectName}.m:ref`);
      const mBuild = deriveUuid(seed, `${objectName}.m:build`);
      children.push(`${hUdid} /* ${objectName}.h */,`, `${mUdid} /* ${objectName}.m */,`);
      fileRefs.push(`${hUdid} /* ${objectName}.h */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.h; path = ${objectName}.h; sourceTree = "<group>"; };\n`);
      fileRefs.push(`${mUdid} /* ${objectName}.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = ${objectName}.m; sourceTree = "<group>"; };\n`);
      sources.push(`${mBuild} /* ${objectName}.m in Sources */,\n`);
      buildFiles.push(`${mBuild} /* ${objectName}.m in Sources */ = {isa = PBXBuildFile; fileRef = ${mUdid} /* ${objectName}.m */; };\n`);
    }
  }

  const folderBlock = `\t\t${folderUdid} /* ${folderName} */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n`
    + children.map(child => `\t\t\t\t${child}`).join('\n')
    + `\n\t\t\t);\n\t\t\tpath = ${folderName};\n\t\t\tsourceTree = "<group>";\n\t\t};`;

  if (pbx) {
    const next = registerInPbxproj(readFileSync(pbx.absolute, 'utf8'), {
      folderRef: `${folderUdid} /* ${folderName} */,`,
      folderBlock,
      fileRefs,
      sources,
      buildFiles,
    });
    if (writeIfChanged(pbx, next)) { changed += 1; changedPaths.push(pbx.relative); }
  }

  return { changed, changedPaths };
}

/**
 * Detect resources never referenced by project code, remove their pbxproj lines,
 * and delete the files / `.imageset` directories.
 */
export function cleanUnusedResources(files: readonly WalkEntry[], options: CleanResourcesOptions = {}): TransformOutcome {
  const ignore = new Set(options.ignore ?? []);
  const resNameMap = new Map<string, { path: string; isDir: boolean; relative: string }>();

  for (const entry of files) {
    const rel = entry.relative;
    if (`/${rel}`.includes('/Pods/') || rel.includes('.appiconset') || rel.includes('.launchimage')) continue;
    const imageset = imagesetDirOf(entry.absolute);
    if (imageset) {
      const name = basenameOf(imageset).split('.')[0]!;
      resNameMap.set(name, { path: imageset, isDir: true, relative: imagesetRelative(rel) });
    } else if (isResourcePath(rel)) {
      resNameMap.set(resourceNameFromPath(rel), { path: entry.absolute, isDir: false, relative: rel });
    }
  }

  for (const name of ignore) resNameMap.delete(name);

  const remaining = new Set(resNameMap.keys());
  for (const entry of files) {
    if (!isSearchCarrier(entry.relative)) continue;
    const content = readFileSync(entry.absolute, 'utf8');
    for (const line of content.split('\n')) {
      for (const ref of lineReferencesResource(line, remaining)) resNameMap.delete(ref);
    }
  }

  const changedPaths: string[] = [];
  let changed = 0;

  const pbx = files.find(file => file.relative.endsWith('project.pbxproj'));
  if (pbx) {
    const next = cleanPbxproj(readFileSync(pbx.absolute, 'utf8'), new Set(resNameMap.keys()));
    if (writeIfChanged(pbx, next)) { changed += 1; changedPaths.push(pbx.relative); }
  }

  for (const item of resNameMap.values()) {
    if (item.isDir) {
      if (existsSync(item.path)) { rmSync(item.path, { recursive: true, force: true }); changed += 1; changedPaths.push(item.relative); }
    } else if (existsSync(item.path)) {
      unlinkSync(item.path);
      changed += 1;
      changedPaths.push(item.relative);
    }
  }

  return { changed, changedPaths };
}
