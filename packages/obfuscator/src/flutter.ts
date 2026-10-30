import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { TransformOutcome, WalkEntry } from './common.js';
import { deriveHash, deriveUuid, escapeRegExp, seededRandom, writeIfChanged } from './common.js';

/**
 * Deterministic "Flutter obfuscation" core: naming rules, filter/whitelist sets,
 * comment-stripping behaviour, resource reference rewriting, resource hash padding and
 * project.pbxproj UUID remapping. Every random draw is seeded, so identical
 * (files + options + seed) always produce byte-identical output.
 */

type Rng = () => number;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** 0 = my-rule (default), 1 = enchant (falls back to my-rule), 2 = my-rule, 3 = random string. */
export type FlutterMissAlgorithm = 0 | 1 | 2 | 3;

export interface FlutterFeatures {
  variable?: boolean;
  className?: boolean;
  method?: boolean;
  resourceName?: boolean;
  resourceHash?: boolean;
  deleteNotes?: boolean;
  uuid?: boolean;
}

export interface FlutterOptions {
  prefixWord?: string;
  missAlgorithmType?: FlutterMissAlgorithm;
  classWhiteList?: readonly string[];
  methodWhiteList?: readonly string[];
  variableWhiteList?: readonly string[];
  features?: FlutterFeatures;
}

export interface NormalizedFlutterOptions {
  prefixWord: string;
  missAlgorithmType: FlutterMissAlgorithm;
  classWhiteList: readonly string[];
  methodWhiteList: readonly string[];
  variableWhiteList: readonly string[];
  features: Required<FlutterFeatures>;
}

const ALL_FEATURES: Required<FlutterFeatures> = {
  variable: true, className: true, method: true, resourceName: true,
  resourceHash: true, deleteNotes: true, uuid: true,
};

export function normalizeFlutterOptions(options: FlutterOptions = {}): NormalizedFlutterOptions {
  return {
    prefixWord: options.prefixWord ?? '',
    missAlgorithmType: options.missAlgorithmType ?? 0,
    classWhiteList: options.classWhiteList ?? [],
    methodWhiteList: options.methodWhiteList ?? [],
    variableWhiteList: options.variableWhiteList ?? [],
    features: { ...ALL_FEATURES, ...(options.features ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Fixed filter / whitelist sets from the original modules
// ---------------------------------------------------------------------------

export const FLUTTER_MUST_WHITE_CLASSES: readonly string[] = ['MyApp'];

export const FLUTTER_IGNORE_METHODS: readonly string[] = [
  'main', 'build', 'initState', 'dispose', 'didUpdateWidget', 'reassemble',
  'setState', 'deactivate', 'activate', 'didChangeDependencies', 'debugFillProperties',
];

export const FLUTTER_IGNORE_VARIABLES: readonly string[] = [
  'value', 'size', 'width', 'height', 'length', 'r', 'msg', 'realUri', 'data',
  'file', 'status', 'controller', 'key',
];

export const FLUTTER_CONSTANT_KEYWORDS: readonly string[] = ['static', 'const', 'final', 'var', 'late'];

export const FLUTTER_BASIC_DATA_TYPES: readonly string[] = [
  'Number', 'int', 'double', 'num', 'String', 'Boolean', 'bool', 'List', 'Map',
  'symbol', 'abs', 'ceil', 'floor', 'void',
];

export const FLUTTER_BASIC_CONTROL_TYPES: readonly string[] = [
  'Widget', 'MaterialApp', 'MaterialColor', 'MaterialButton', 'RawMaterialButton',
  'MaterialPageRoute', 'MaterialAccentColor', 'MergeableMaterialItem', 'AppBar',
  'BottomAppBar', 'BottomNavigationBarItem', 'SnackBar', 'ScrollbarPainter',
  'FlexileSpaceBar', 'ButtonBar', 'SnackBarAction', 'TabBar', 'AlertDialog', 'Dialog',
  'AboutDialog', 'SimpleDialog', 'Scaffold', 'ScaffoldState', 'ScrollView', 'Scrollable',
  'SingleChildScrollView', 'ScrollNotfication', 'NotificationListener', 'ScrollbarPainter',
  'ScrollMetrics', 'ScrollPhysics', 'BoxScrollView', 'CustomScrollView', 'NestedScrollView',
  'GridTile', 'GridView', 'GridPaper', 'SliverGrid', 'GridTileBar', 'AnimatedList',
  'ListView', 'ListBody', 'ExpansionPanelList', 'PageView', 'Align', 'Stack', 'IndexdStack',
  'Row', 'Column', 'Container', 'Center', 'ConstrainedBox', 'OverflowBox', 'DecoratedBox',
  'RendorDecoratedBox', 'FittedBox', 'LimitedBox', 'RotatedBox', 'SizedBox',
  'SizeOverflowBox', 'UnconstrainedBox', 'Expanded', 'Padding', 'SliverPadding',
  'AnimatedPadding', 'Table', 'Card', 'TextField', 'Checkbox', 'CheckboxListTile',
  'FlatButton', 'RaisedButton', 'IconButton', 'PopupMenuButton', 'FloatingActionButton',
  'RawMaterialButton', 'DropdownButton', 'OutlineButton', 'Text', 'RichText', 'Radio',
  'RadioListTile', 'Slider', 'SliderTheme', 'SliderThemeData', 'Switch', 'SwitchListTile',
  'AnimatedSwitcher', 'AssetImage', 'DecorationImage', 'ExactAssetImage', 'FadeInImage',
  'FileImage', 'NetworkImage', 'RawImage', 'MemoryImage', 'ImageImageIcon', 'IconTheme',
  'IconData', 'IconThemeData', 'Canvas', 'PainterSketch', 'PainterPath',
  'CircleProgressBarPainter', 'BottomNavigationBarItem', 'BottomNavigationBar', 'Tab',
  'CheckedPopupMenuItem', 'DropdownMenuItem', 'PopupMenuBottom', 'PopupMenuDivider',
  'PopopMenuEntry', 'PopupMenuItem', 'DayPicker', 'MonthPicker', 'YearPicker',
  'ShowdatePicker', 'CityPicker', 'Chip', 'ChipTheme', 'ChipThemeData', 'ChoiceChip',
  'FilterChip', 'InputChip', 'RawChip', 'ClipOval', 'ClipRect', 'ClipRRect', 'ClipPath',
  'CustomClipper', 'BorderRadius', 'CircularPercentIndicator', 'LinearProgressIndicator',
  'NestedScrollViewRefreshIndicator', 'SwipeRefreshLayout', 'BoxDecoration',
  'ShapeDecoration', 'InkDecoration', 'FlutterLogoDecoration', 'InputDecoration',
  'TextDecoration', 'RoundedRectangleBorder', 'BoxShape', 'CircleBorder', 'CupertinoApp',
  'CupertinoButton', 'CupertinoColors', 'CupertinoIcons', 'CupertinoNavigationBar',
  'CupertinoPageRoute', 'CupertinoPageScaffold', 'CupertinoPicker', 'CupertinoPopupSurface',
  'CupertinoScrollbar', 'CupertinoSlider', 'CupertinoSegmentedControl',
  'CupertinoSliverNavigationBar', 'CupertinoSwitch', 'CupertinoTabBar',
  'CupertinoTabScafold', 'CupertinoTabView', 'CupertinoTimerPicker', 'SliverAppBar',
  'SliverFixedExtentList', 'SliverList', 'SliverGrid', 'SliverPersistentHeader',
  'SliverFixedExtentList', 'SliverToBoxAdapter', 'Localizations', 'Semantics', 'Label',
  'Positioned', 'Ink', 'InkWell', 'ViewController', 'Drawer', 'Divider', 'GestureDetector',
  'FocusScope', 'WillPopScope', 'SafeArea', 'Transform',
];

const MUST_WHITE_CLASS_SET = new Set(FLUTTER_MUST_WHITE_CLASSES);
const IGNORE_METHOD_SET = new Set(FLUTTER_IGNORE_METHODS);
const IGNORE_VARIABLE_SET = new Set(FLUTTER_IGNORE_VARIABLES);
const CONSTANT_KEYWORD_SET = new Set(FLUTTER_CONSTANT_KEYWORDS);
const BASIC_DATA_SET = new Set(FLUTTER_BASIC_DATA_TYPES);
const BASIC_CONTROL_SET = new Set(FLUTTER_BASIC_CONTROL_TYPES);

const PUNCTUATION_EXCEPT_UNDERSCORE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^`{|}~');
const UPPER_AND_LOWER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// ---------------------------------------------------------------------------
// Lexicon (deterministic 2400-word subset, sampled with a fixed seed).
// ---------------------------------------------------------------------------

const LEXICON: readonly string[] = [
  "sideroblast", "siderochrome", "siderocyte", "siderography", "siderolite", "siderophilin", "sideroscope", "siderosis", "siderostat", "sidesaddle", "sideseat", "sideshow",
  "sideslip", "sidesman", "sidespin", "sidesplitter", "sidesplitting", "sidestep", "sidestream", "sidestroke", "sideswipe", "sidetone", "sidetrack", "sidewalk",
  "sideward", "sidewards", "sideway", "sideways", "sidewipe", "sidewise", "sidi", "siding", "sidle", "sidon", "sidonian", "sidra",
  "siege", "siegfried", "siena", "sienese", "sienna", "sierozem", "sierra", "sierran", "siesta", "sieur", "sieva", "sieve",
  "sievert", "sifaka", "siff", "siffleur", "siffleuse", "sift", "sifter", "sig", "sigh", "sight", "sighthole", "sightless",
  "sightline", "sightly", "sightproof", "sightsee", "sightseeing", "sightseer", "sightsinging", "sightworthy", "sigil", "sigillographer", "sigillography", "sigillum",
  "sigint", "sigla", "siglos", "sigmate", "sigmatropic", "sigmoid", "sigmoidectomy", "sigmoiditis", "sigmoidoscope", "sigmoidostomy", "sign", "signable",
  "signaler", "signaling", "signalise", "signality", "signalize", "signalled", "signally", "signalman", "signalment", "signans", "signary", "signatary",
  "signatory", "signatum", "signatureless", "signboard", "signed", "signee", "signet", "signifiable", "signifiant", "significance", "significancy", "significans",
  "significant", "significantly", "signification", "significative", "significatory", "significs", "signify", "signior", "signiory", "signman", "signor", "signore",
  "signori", "signorina", "signorine", "signorini", "signorino", "signory", "signpost", "signwriter", "sigri", "sigrid", "sigurd", "sihanouk",
  "sijo", "sika", "siker", "sikh", "sikkim", "sikkimese", "silage", "silane", "silanization", "silanize", "silas", "silastic",
  "silbador", "silbo", "sild", "sile", "silence", "silencer", "silent", "silentious", "silently", "silenus", "silesia", "silex",
  "silhouette", "silica", "silicate", "siliceous", "silicic", "silicicolous", "silicide", "silicidize", "silicification", "silicify", "silicious", "silicium",
  "silicize", "silicle", "silicomanganese", "silicon", "silicone", "silicosis", "silicothermic", "silicula", "silicular", "silicule", "siliqua", "silique",
  "silk", "silkaline", "silken", "silkgrower", "silkiness", "silklike", "silkman", "silkoline", "silkscreen", "silkweed", "silkworm", "silky",
  "sill", "sillabub", "sillar", "siller", "sillibub", "sillily", "sillimanite", "silliness", "sillographer", "silly", "silo", "siloam",
  "siloxane", "silphid", "silt", "siltstone", "silty", "silundum", "silures", "silurid", "siluroid", "silva", "silvan", "silvana",
  "silvanus", "silver", "silverback", "silverbeater", "silverberry", "silverfish", "silvering", "silverless", "silverly", "silvern", "silverpoint", "silverside",
  "silversides", "silversmith", "silvertail", "silverware", "silverweed", "silvery", "silvester", "silvical", "silvichemical", "silvicide", "silvicolous", "silvics",
  "silviculture", "sima", "simar", "simazine", "simba", "simbirsk", "simd", "simferopol", "simian", "similar", "similarity", "similarly",
  "simile", "similitude", "similize", "simious", "simitar", "simla", "simmer", "simoleon", "simoniac", "simoniacal", "simonist", "simonize",
  "simonstown", "simony", "simoom", "simp", "simpai", "simpatico", "simper", "simperingly", "simple", "simplehearted", "simpleminded", "simpleness",
  "simpleton", "simplex", "simplicidentate", "simplicist", "simpliciter", "simplicity", "simplification", "simplify", "simplism", "simplist", "simplistic", "simply",
  "simsim", "simtel", "simul", "simulacra", "simulacre", "simulacrum", "simuland", "simulant", "simular", "simulate", "simulation", "simulative",
  "simulator", "simulcast", "simulfix", "simultaneity", "simultaneous", "simultaneously", "sin", "sina", "sinaean", "sinai", "sinaic", "sinaitic",
  "sinal", "sinanthropus", "sinapin", "sinapine", "sinapism", "sinarquist", "sinbad", "since", "sincere", "sincerely", "sincerity", "sincipital",
  "sinciput", "sinclair", "sindolor", "sindon", "sindonology", "sine", "sinecure", "sinecurist", "sinew", "sinewy", "sinfonia", "sinful",
  "sinfully", "sing", "singapore", "singaporean", "singaradja", "singe", "singer", "singhalese", "singing", "single", "singlechip", "singlehanded",
  "singleness", "singlestick", "singlet", "singleton", "singletree", "singly", "singsong", "singspiel", "singular", "singularism", "singularity", "singularize",
  "singularly", "singulative", "singultation", "singultus", "sinhala", "sinhalese", "sinhalite", "sinic", "sinicism", "sinicize", "sinify", "sining",
  "sinister", "sinisterly", "sinistrad", "sinistral", "sinistrocular", "sinistrorse", "sinitic", "sink", "sinkable", "sinkage", "sinker", "sinkful",
  "sinkhole", "sinkiang", "sinking", "sinless", "sinlessly", "sinneh", "sinner", "sinnerite", "sinnet", "sinoatrial", "sinogram", "sinography",
  "sinoite", "sinological", "sinologist", "sinologue", "sinology", "sinophile", "sinophobia", "sinopis", "sinopite", "sinople", "sinpo", "sins",
  "sinsemilla", "sinsyne", "sinter", "sintering", "sintra", "sinuate", "sinuation", "sinuatrial", "sinuiju", "sinuosity", "sinuous", "sinus",
  "sinusitis", "sinusoid", "sinusoidal", "siogon", "sion", "siouan", "sioux", "siphon", "siphonaceous", "siphonage", "siphonal", "siphonate",
  "siphonein", "siphonet", "siphonic", "siphonophore", "siphonostele", "siphunculate", "siphunculated", "sippet", "sipunculan", "siquis", "sir", "sirach",
  "siracusa", "siratro", "sircar", "sirdar", "sire", "siree", "siren", "sirena", "sirenian", "siret", "sirgang", "sirian",
  "siriasis", "sirius", "sirloin", "sirocco", "sirrah", "sirree", "sirtaki", "sirup", "sirupy", "sirvente", "sirventes", "sis",
  "sisal", "siscowet", "sisera", "siskin", "sismogram", "sismograph", "sismographic", "sissified", "sissy", "sistan", "sister", "sisterhood",
  "sisterless", "sisterly", "sistern", "sistership", "sistine", "sistroid", "sistrum", "sisyphean", "sisyphus", "sit", "sitar", "sitcom",
  "site", "sitebuilder", "sitfast", "sith", "sitology", "sitomania", "sitophobia", "sitosterol", "sitotoxin", "sitrep", "sitsang", "sittable",
  "sittang", "sitten", "sitter", "sitting", "sittoung", "sittwe", "situate", "situated", "situation", "situla", "situp", "situs",
  "sitzkrieg", "sitzkrleg", "sitzmark", "siu", "siva", "sivaite", "sivan", "siwan", "six", "sixain", "sixer", "sixern",
  "sixfold", "sixpence", "sixpenny", "sixpennyworth", "sixscore", "sixte", "sixteen", "sixteenmo", "sixteenth", "sixteenthly", "sixth", "sixthly",
  "sixtieth", "sixtine", "sixty", "sixtyfold", "sizable", "sizar", "size", "sizeable", "sized", "sizer", "sizing", "sizy",
  "sizz", "sizzard", "sizzle", "sizzler", "sjaa", "sjab", "sjaelland", "sjambok", "sjc", "sjd", "skagerrak", "skald",
  "skandalon", "skat", "skate", "skatebarrow", "skateboard", "skatemobile", "skatepark", "skater", "skating", "skatol", "skatole", "skean",
  "sked", "skedaddle", "skee", "skeeler", "skeesicks", "skeet", "skeeter", "skeetshoot", "skegger", "skein", "skelecton", "skeletal",
  "skeletogenous", "skeleton", "skeletonize", "skeletonless", "skeletony", "skellum", "skelp", "skelter", "skeltonics", "sken", "skene", "skep",
  "skepsis", "skeptic", "skeptical", "skeptically", "skepticism", "skepticize", "skerrick", "skerry", "sket", "sketch", "sketchbook", "sketchily",
  "sketchpad", "sketchy", "skete", "skew", "skewback", "skewbald", "skewer", "skewwhiff", "skfros", "ski", "skiagram", "skiagraph",
  "skiagraphy", "skiamachy", "skiametry", "skiascope", "skiascopy", "skibby", "skibob", "skibobber", "skibobbing", "skice", "skid", "skidder",
  "skiddoo", "skiddy", "skidoo", "skidproof", "skier", "skiey", "skiff", "skiffle", "skiing", "skijoring", "skikda", "skilful",
  "skill", "skilled", "skillet", "skillful", "skillfully", "skillion", "skilly", "skim", "skimboard", "skimeister", "skimmer", "skimming",
  "skimo", "skimobile", "skimp", "skimpily", "skimpy", "skin", "skinbound", "skinch", "skinflint", "skinfold", "skinful", "skinhead",
  "skink", "skinner", "skinnerian", "skinniness", "skinny", "skinpopping", "skint", "skintight", "skiogram", "skiograph", "skip", "skipjack",
  "skiplane", "skippable", "skipper", "skippet", "skippingly", "skippy", "skirl", "skirmish", "skirmisher", "skirr", "skirret", "skirt",
  "skirting", "skiscooter", "skish", "skit", "skite", "skitter", "skittish", "skittle", "skive", "skiver", "skivey", "skivvy",
  "skiwear", "sklodowskite", "skoal", "skokiaan", "skolly", "skoob", "skookum", "skopje", "skoplje", "skosh", "skotophile", "skua",
  "skulduggery", "skulk", "skulker", "skull", "skullcap", "skullduggery", "skullfish", "skullguard", "skunk", "skunkery", "skupshtina", "skurfing",
  "skutari", "skutterudite", "sky", "skyborne", "skybridge", "skycap", "skycoach", "skydive", "skyer", "skyey", "skyful", "skyish",
  "skyjack", "skyjacking", "skylab", "skylark", "skylarker", "skylarking", "skyless", "skylight", "skyline", "skylit", "skylon", "skylounge",
  "skymark", "skymotel", "skyphone", "skyphos", "skyport", "skyrocket", "skysail", "skyscape", "skyscrape", "skyscraper", "skyscraping", "skysweeper",
  "skytrooper", "skytroops", "skywalk", "skyward", "skywards", "skywatch", "skyway", "skywriting", "sla", "slab", "slabber", "slabby",
  "slablike", "slabstone", "slack", "slackage", "slacken", "slacker", "sladang", "slade", "slag", "slagging", "slaggy", "slagheap",
  "slain", "slaister", "slake", "slakeless", "slaky", "slalom", "slam", "slammer", "slan", "slanchways", "slanchwise", "slander",
  "slanderella", "slanderer", "slanderous", "slanderously", "slang", "slangster", "slanguage", "slangy", "slank", "slant", "slantendicular", "slantindicular",
  "slantingways", "slantingwise", "slantways", "slantwise", "slap", "slapdab", "slapdash", "slapdashery", "slaphappy", "slapjack", "slapman", "slapping",
  "slapstick", "slash", "slashing", "slat", "slatch", "slate", "slater", "slather", "slating", "slatted", "slatter", "slattern",
  "slatternly", "slaty", "slaughter", "slaughterhouse", "slaughterous", "slav", "slavdom", "slave", "slaveholder", "slaveholding", "slaveocracy", "slaver",
  "slavery", "slavey", "slavic", "slavicist", "slavicize", "slavikite", "slavish", "slavishly", "slavism", "slavist", "slavocracy", "slavonia",
  "slavonian", "slavonic", "slavonize", "slavophil", "slavophile", "slavophobe", "slavophobist", "slaw", "slay", "sldram", "sleave", "sleazy",
  "sled", "sledding", "sledge", "sledgehammer", "sledgemeter", "sleek", "sleekly", "sleep", "sleepcoat", "sleeper", "sleepful", "sleepily",
  "sleepiness", "sleeping", "sleepless", "sleepwalker", "sleepwalking", "sleepwear", "sleepy", "sleepyhead", "sleet", "sleety", "sleeve", "sleeveboard",
  "sleeveen", "sleeveless", "sleevelet", "sleigh", "sleighing", "sleight", "slender", "slenderize", "slenderly", "slentando", "slept", "sleugh",
  "sleuth", "sleuthhound", "slew", "sley", "slezsko", "slic", "slice", "sliceable", "slicer", "slick", "slicken", "slickenside",
  "slicker", "slickness", "slickrock", "slickster", "slid", "slidden", "slide", "slideway", "sliding", "slight", "slighting", "slightingly",
  "slightly", "slightness", "slily", "slim", "slime", "slimicide", "sliminess", "slimline", "slimly", "slimmer", "slimming", "slimmish",
  "slimnastics", "slimsy", "slimy", "sling", "slingback", "slinger", "slingman", "slingshop", "slingshot", "slink", "slinkingly", "slinkskin",
  "slinkweed", "slinky", "slip", "slipcase", "slipcover", "slipform", "sliphorn", "slipknot", "slipover", "slippage", "slipper", "slipperwort",
  "slippery", "slippy", "sliprail", "slipsheet", "slipshod", "slipslop", "slipsole", "slipstick", "slipstone", "slipstream", "slipt", "slipup",
  "slipware", "slipway", "slit", "slither", "slithery", "sliver", "slivovitz", "sloak", "sloat", "slob", "slobber", "slobbery",
  "sloe", "slog", "slogan", "sloganeer", "slogger", "slogging", "sloid", "slojd", "sloop", "sloot", "slop", "slope",
  "slopehead", "slopewash", "sloping", "sloppy", "slopseller", "slopshop", "slopwork", "slopy", "slosh", "sloshy", "slotback", "slote",
  "sloth", "slothful", "slothfully", "slothfulness", "slotware", "slouch", "slouching", "slouchy", "slough", "sloughy", "slovak", "slovakian",
  "sloven", "slovene", "slovenia", "slovenian", "slovenly", "slovenry", "slovensko", "slow", "slowdown", "slower", "slowgoing", "slowhound",
  "slowish", "slowly", "slowness", "slowpaced", "slowpoke", "slowup", "slowworm", "sloyd", "slp", "slub", "slubber", "slubberdegullion",
  "slubbing", "sludge", "sludgeworm", "sludgy", "slue", "slug", "slugabed", "slugfest", "sluggard", "sluggardly", "slugger", "slugging",
  "sluggish", "sluice", "sluiceway", "sluit", "slum", "slumber", "slumbercoach", "slumberland", "slumberous", "slumbery", "slumbrous", "slumdweller",
  "slumgum", "slumland", "slumlord", "slummer", "slummock", "slummy", "slump", "slung", "slungshot", "slunk", "slup", "slur",
  "slurp", "slurry", "slurvian", "slush", "slushy", "slut", "sluttery", "sluttish", "slv", "sly", "slyboots", "slyly",
  "slype", "smack", "smacker", "smackeroo", "smackhead", "smacking", "smacksman", "small", "smallage", "smallboy", "smallclothes", "smallholder",
  "smallholding", "smallish", "smallmouth", "smallness", "smallpox", "smallshot", "smallsword", "smallwares", "smally", "smalt", "smalti", "smaltine",
  "smaltite", "smalto", "smaragd", "smaragdine", "smaragdite", "smarm", "smarmy", "smartdrive", "smarten", "smartless", "smartly", "smartness",
  "smartweed", "smarty", "smash", "smashed", "smasher", "smasheroo", "smashing", "smashup", "smatter", "smattering", "smattery", "smaze",
  "smb", "smd", "smds", "smear", "smearcase", "smeary", "smeech", "smegma", "smell", "smellage", "smeller", "smellie",
  "smelly", "smelt", "smelter", "smeltery", "smelting", "smerrebrxd", "smew", "smf", "smg", "smice", "smidgen", "smidgeon",
  "smiercase", "smilacaceous", "smile", "smileless", "smiley", "smiling", "smilingly", "smilodon", "smirch", "smirk", "smirky", "smirnoff",
  "smitch", "smite", "smith", "smithcraft", "smithereen", "smithereens", "smithery", "smithiantha", "smithite", "smithsonite", "smithwork", "smithy",
  "smitten", "smitty", "smock", "smocking", "smog", "smogbound", "smoggy", "smogout", "smokable", "smokables", "smoke", "smokeable",
  "smokebell", "smokebox", "smokechaser", "smokehouse", "smokeless", "smokemeter", "smokepot", "smokeproof", "smokery", "smokestack", "smoketight", "smokey",
  "smokily", "smoking", "smoko", "smoky", "smolder", "smolensk", "smolt", "smon", "smooch", "smoodge", "smooth", "smoothbore",
  "smoothen", "smoother", "smoothhound", "smoothie", "smoothly", "smoothness", "smoothy", "smorgasbord", "smorzando", "smote", "smother", "smotheration",
  "smothery", "smouch", "smoulder", "smriti", "smsa", "smtpd", "smudge", "smudgily", "smudginess", "smudgy", "smug", "smuggle",
  "smuggler", "smuggling", "smugness", "smut", "smutch", "smuttily", "smuttiness", "smutty", "smyrna", "smyrniot", "smythite", "snack",
  "snackery", "snacketeria", "snackette", "snaffle", "snafu", "snag", "snagged", "snaggletooth", "snaggletoothed", "snaggy", "snail", "snailery",
  "snailfish", "snaillike", "snake", "snakebird", "snakebite", "snakefly", "snakehead", "snakeless", "snakelet", "snakelike", "snakemouth", "snakeroot",
  "snakeskin", "snakestone", "snakewood", "snakey", "snakish", "snaky", "snallygaster", "snap", "snapback", "snapbolt", "snapdragon", "snaphance",
  "snaphaunce", "snapper", "snappish", "snappy", "snapshoot", "snare", "snark", "snarl", "snarler", "snarlingly", "snarly", "snash",
  "snatch", "snatchback", "snatchy", "snath", "snathe", "snax", "snazzy", "sncc", "sncf", "snead", "sneak", "sneaker",
  "sneaking", "sneakingly", "sneaksby", "sneaky", "sned", "sneer", "sneering", "sneeringly", "sneery", "sneesh", "sneeshing", "sneeze",
  "sneezes", "sneezy", "snell", "snelskrif", "snib", "snick", "snicker", "snickersnee", "snicket", "snide", "snidesman", "sniff",
  "sniffable", "sniffer", "sniffish", "sniffle", "sniffy", "snift", "snifter", "snifty", "snig", "sniggle", "snip", "snipe",
  "snipehunt", "snipehunter", "sniper", "sniperscope", "snipey", "snippers", "snippersnapper", "snippet", "snippety", "snipping", "snippy", "snit",
  "snitch", "snivel", "sniveler", "sniveller", "snmp", "snob", "snobbery", "snobbish", "snobbishness", "snobbism", "snobby", "snobism",
  "snobling", "snobol", "snockered", "snoek", "snofari", "snog", "snollygoster", "snood", "snook", "snooker", "snoop", "snooper",
  "snooperscope", "snoopery", "snoopy", "snoot", "snootful", "snooty", "snooze", "snopes", "snopesian", "snore", "snorer", "snort",
  "snorter", "snorty", "snot", "snotnose", "snotty", "snottynose", "snout", "snovian", "snow", "snowball", "snowbank", "snowbell",
  "snowberry", "snowbird", "snowblink", "snowbound", "snowbreak", "snowbrush", "snowbush", "snowcap", "snowcapped", "snowcat", "snowcem", "snowcraft",
  "snowcreep", "snowdon", "snowdrift", "snowdrop", "snowfall", "snowfield", "snowflake", "snowhole", "snowhouse", "snowmaking", "snowman", "snowmelt",
  "snowmobile", "snowmobilist", "snowpack", "snowplow", "snowscape", "snowshed", "snowshoe", "snowslide", "snowslip", "snowstorm", "snowsuit", "snowswept",
  "snowwhite", "snowy", "snr", "snub", "snubber", "snubbingly", "snubby", "snuck", "snuff", "snuffbox", "snuffcolored", "snuffcoloured",
  "snuffer", "snuffers", "snuffle", "snuffless", "snuffling", "snuffy", "snug", "snuggery", "snuggies", "snuggish", "snuggle", "snugly",
  "snurfing", "snuzzle", "snye", "soak", "soakage", "soaked", "soaker", "soapbark", "soapberry", "soapbox", "soapboxer", "soaper",
  "soapery", "soapie", "soapmaking", "soapolallie", "soaprock", "soapstone", "soapsuds", "soapwort", "soapy", "soar", "soarable", "soaraway",
  "soaring", "soave", "soavemente", "sob", "sobbing", "sobby", "sobeit", "sober", "soberano", "sobering", "soberize", "soberly",
  "soberminded", "sobersides", "sobranje", "sobriety", "sobriquet", "socage", "soccage", "soccer", "sochi", "sociability", "sociable", "sociably",
  "social", "socialise", "socialism", "socialist", "socialistic", "socialistically", "socialite", "sociality", "socialization", "socialize", "socializee", "socially",
  "societal", "society", "socinian", "socinianism", "sociobiology", "sociocentric", "sociocentrism", "sociocracy", "sociocultural", "socioecology", "socioeconomic", "sociogenetic",
  "sociogenic", "sociogenous", "sociogeny", "sociogram", "sociogroup", "sociolect", "sociolinguistics", "sociologese", "sociological", "sociologically", "sociologise", "sociologism",
  "sociologist", "sociologize", "sociology", "sociometry", "sociopath", "sociopathic", "sociopolitical", "socioreligious", "sociosexual", "sociotechnological", "socius", "sock",
  "sockdolager", "socker", "sockeroo", "socket", "sockeye", "socko", "socle", "socman", "socotra", "socratic", "socratism", "socred",
  "sod", "soda", "sodalist", "sodalite", "sodality", "sodamide", "sodar", "sodden", "soddish", "soddy", "sodic", "sodium",
  "sodom", "sodomist", "sodomite", "sodomize", "sodomy", "sodwork", "soed", "soekarno", "soemba", "soembawa", "soerabaja", "soerakarta",
  "soever", "sof", "sofa", "sofar", "soffit", "sofia", "soft", "softback", "softball", "softbank", "softboard", "softbound",
  "soften", "softening", "softgoods", "softhead", "softheaded", "softhearted", "softish", "softland", "softly", "softness", "softpanel", "softwood",
  "softy", "sogat", "soggy", "soho", "soigne", "soignee", "soil", "soilage", "soilborne", "soilless", "soily", "soiree",
  "soja", "sojourn", "sojourner", "soke", "sokeman", "sokol", "sokotra", "sol", "solace", "solaceful", "solacet", "solan",
  "solanaceous", "solander", "solanine", "solano", "solanum", "solar", "solaria", "solarimeter", "solaris", "solarise", "solarism", "solarium",
  "solarization", "solarize", "solarometer", "solate", "solatia", "solatium", "sold", "soldan", "soldanella", "solder", "solderability", "solderable",
  "soldi", "soldier", "soldierlike", "soldierly", "soldiership", "soldiery", "soldo", "sole", "solebar", "solecism", "solecist", "solecistic",
  "solecize", "soleiform", "solely", "solemn", "solemnify", "solemnise", "solemnity", "solemnization", "solemnize", "solemnly", "solemnness", "solen",
  "solenocyte", "solenodon", "solenoglyph", "solenoid", "soleplate", "soleprint", "soleus", "solfatara", "solfege", "solfeggio", "solgel", "soli",
  "solicit", "solicitant", "solicitation", "solicitor", "solicitorship", "solicitous", "solicitously", "solicitude", "solicitudinous", "solid", "solidago", "solidaric",
  "solidarist", "solidarity", "solidarize", "solidary", "solidi", "solidification", "solidify", "solidity", "solidly", "solidness", "solidungulate", "solidus",
  "solifidian", "solifidianism", "soliflucted", "solifluction", "solifluxion", "soligenous", "soliloquise", "soliloquist", "soliloquize", "soliloquy", "solingen", "solion",
  "soliped", "solipsism", "solitaire", "solitarily", "solitary", "solitude", "solitudinarian", "soljanka", "solleret", "sollicker", "solmisation", "solmizate",
  "solmization", "soln", "solo", "solodize", "soloist", "soloistic", "solon", "solonchak", "solonetz", "solstice", "solstitial", "solubilisation",
  "solubilise", "solubility", "solubilization", "solubilize", "solubilizer", "soluble", "solunar", "solus", "solute", "solutionist", "solutizer", "solutrean",
  "solvability", "solvable", "solvate", "solve", "solvency", "solvend", "solvent", "solvolysis", "solyanka", "soma", "somal", "somali",
  "somaliland", "somaplasm", "somascope", "somasteroid", "somatic", "somatization", "somatocoel", "somatogamy", "somatogenetic", "somatogenic", "somatological", "somatology",
  "somatomedin", "somatoplasm", "somatopleure", "somatopsychic", "somatosensory", "somatostatin", "somatotherapy", "somatotonic", "somatotopic", "somatotopical", "somatotroph", "somatotrophic",
  "somatotrophin", "somatotropin", "somatotype", "somber", "somberly", "sombre", "sombrero", "sombrous", "some", "somebody", "someday", "somedeal",
  "somehow", "someone", "someplace", "somersault", "somerset", "somersetshire", "somerville", "somesthetic", "somesuch", "something", "sometime", "sometimes",
  "sometimey", "someway", "someways", "somewhat", "somewhere", "somewhile", "somewhither", "somewhy", "somewise", "somite", "sommelier", "somnambulance",
  "somnambulant", "somnambular", "somnambulary", "somnambulate", "somnambule", "somnambulic", "somnambulism", "somnambulist", "somnial", "somnifacient", "somniferous", "somnific",
  "somniloquence", "somniloquism", "somniloquist", "somniloquous", "somniloquy", "somnivolency", "somnolence", "somnolency", "somnolent", "somnus", "sompa", "son",
  "sonable", "sonagram", "sonagraph", "sonal", "sonance", "sonant", "sonantize", "sonar", "sonarman", "sonata", "sonatina", "sonation",
  "sondage", "sonderclass", "sonderkommando", "sone", "sonet", "song", "songbird", "songbook", "songcraft", "songfest", "songful", "songkhla",
  "songkok", "songless", "songlet", "songlike", "songman", "songsmith", "songster", "songstress", "sonic", "sonicate", "sonication", "sonicguide",
  "sonifer", "soniferous", "sonifier", "sonless", "sonlike", "sonly", "sonnet", "sonneteer", "sonnetist", "sonnetize", "sonny", "sonobuoy",
  "sonochemical", "sonochemistry", "sonofabitch", "sonofer", "sonograph", "sonography", "sonoluminescence", "sonolyse", "sonolysis", "sonolyze", "sonometer", "sonorant",
  "sonorific", "sonority", "sonorization", "sonorize", "sonorous", "sonorously", "sonorousness", "sonovox", "sonship", "sonsie", "sonsy", "sonuvabitch",
  "sony", "sonya", "soochong", "soochow", "soodling", "sooey", "soogan", "soogee", "sook", "sool", "soon", "soot",
  "sootfall", "sooth", "soothe", "soother", "soothing", "soothingly", "soothly", "soothsay", "soothsayer", "soothsaying", "sootily", "sootiness",
  "sootlike", "sooty", "sop", "sopaipilla", "sopapilla", "soper", "soph", "sophi", "sophic", "sophism", "sophist", "sophister",
  "sophistic", "sophistical", "sophisticate", "sophisticated", "sophistication", "sophisticator", "sophistry", "sophoclean", "sophomore", "sophomoric", "sophomorical", "sophonias",
  "sopite", "sopor", "soporiferous", "soporific", "soporose", "soporous", "sopot", "sopped", "sopping", "soppy", "soprani", "sopranino",
  "sopranist", "soprano", "soqotra", "sora", "sorb", "sorbefacient", "sorbent", "sorbian", "sorbitol", "sorbo", "sorbol", "sorbonne",
  "sorbonnist", "sorbose", "sorcerer", "sorceress", "sorcerize", "sorcery", "sordamente", "sordid", "sordidly", "sore", "soredial", "soredium",
  "sorefalcon", "sorehawk", "sorehead", "sorel", "sorely", "soreness", "sorgho", "sorghum", "sorgo", "sori", "sorites", "sorn",
  "soroban", "soroptimist", "sororal", "sororate", "sororial", "sororicide", "sorority", "sororize", "sorosilicate", "sorosis", "sorption", "sorrel",
  "sorrily", "sorriness", "sorrow", "sorrowful", "sorrowfully", "sorry", "sort", "sorta", "sortable", "sortation", "sorter", "sortes",
  "sortie", "sortilege", "sortita", "sortition", "sorus", "sos", "sostenuto", "sot", "soterial", "soteriology", "sothiac", "sothiacal",
  "sothic", "sothis", "sotol", "sots", "sotted", "sottish", "sou", "souari", "soubise", "soubresaut", "soubrette", "soubriquet",
  "soucar", "souchong", "soudan", "soudanese", "souffle", "sough", "sought", "soul", "soulful", "soulless", "sound", "soundboard",
  "sounder", "soundex", "soundful", "sounding", "soundless", "soundlessly", "soundly", "soundness", "soundproof", "soundrec", "soundscape", "soundscriber",
  "soupcon", "soupfin", "soupiness", "soupy", "sour", "sourball", "sourcebook", "sourcrout", "sourdine", "sourdough", "sourish", "sourkrout",
  "sourly", "sourness", "sourpuss", "soursop", "sousaphone", "souse", "souslik", "sousse", "soutache", "soutane", "soutar", "souteneur",
  "souter", "souterrain", "south", "southabout", "southampton", "southbound", "southdown", "southeast", "southeaster", "southeasterly", "southeastern", "southeasternmost",
  "southeastward", "southeastwards", "souther", "southerly", "southern", "southerner", "southernization", "southernly", "southernmost", "southernwood", "southing", "southland",
  "southmost", "southpaw", "southron", "southward", "southwardly", "southwards", "southwest", "southwester", "southwesterly", "southwestern", "southwesternmost", "southwestward",
  "southwestwards", "southwide", "souvenir", "souvlaki", "souwester", "souzalite", "sov", "sovereign", "sovereignty", "soviet", "sovietise", "sovietism",
  "sovietist", "sovietization", "sovietize", "sovietologist", "sovietology", "sovkhoz", "sovnarkhoz", "sovprene", "sovran", "sovranty", "sow", "sowback",
  "sowbelly", "sowbread", "sowbug", "sowcar", "sowens", "sower", "soweto", "sown", "sowntown", "soy", "soya", "soyaburger",
  "soybean", "soymilk", "sozin", "sozzled", "spa", "space", "spacearium", "spaceband", "spacebar", "spacecraft", "spacefarer", "spaceflight",
  "spaceless", "spacelift", "spaceman", "spacemark", "spaceplane", "spaceport", "spacer", "spaceship", "spacesickness", "spacewalk", "spaceward", "spaceway",
  "spacewoman", "spaceworthy", "spacial", "spacing", "spacious", "spaciously", "spacistor", "spackle", "spadable", "spade", "spadebone", "spadefoot",
  "spadeful", "spadework", "spadger", "spadices", "spadicose", "spadille", "spadish", "spadix", "spado", "spae", "spaeman", "spaetzle",
  "spaewife", "spag", "spaggers", "spaghetti", "spaghettini", "spagyric", "spahee", "spahi", "spain", "spaish", "spait", "spake",
  "spalato", "spall", "spallation", "spalpeen", "span", "spanaemia", "spancel", "spandrel", "spandril", "spandy", "spang", "spangle",
  "spanglish", "spaniard", "spaniel", "spanish", "spank", "spanker", "spanking", "spanless", "spanned", "spanner", "spanning", "spanrail",
  "spanwise", "spanworm", "spar", "sparable", "sparaxis", "spare", "sparely", "spareness", "sparerib", "sparganosis", "sparganum", "sparge",
  "sparid", "sparing", "sparingly", "spark", "sparkish", "sparkle", "sparkler", "sparkless", "sparklet", "sparkling", "sparklingly", "sparkplug",
  "sparkproof", "sparmate", "sparrow", "sparrowgrass", "sparry", "sparse", "sparsely", "sparseness", "sparsity", "sparta", "spartacist", "spartacus",
  "spartan", "spartanism", "spartanize", "sparteine", "spasm", "spasmic", "spasmodic", "spasmodical", "spasmodically", "spasmodism", "spasmodist", "spasmogen",
  "spasmogenic", "spasmolysis", "spasmolytic", "spasmophilia", "spastic", "spat", "spatchcock", "spate", "spathal", "spathe", "spathic", "spathiform",
  "spathulate", "spatial", "spatiality", "spatiography", "spatioperceptual", "spatiotemporal", "spatted", "spatter", "spatterdash", "spatterdock", "spatterware", "spatula",
  "spatulate", "spatuliform", "spatzle", "spavin", "spavined", "spawn", "spawny", "spay", "spaz", "spc", "spca", "spcc",
];

// ---------------------------------------------------------------------------
// Small faithful primitives
// ---------------------------------------------------------------------------

/** Python `str.capitalize`: uppercase first char, lowercase the rest. */
export function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1).toLowerCase();
}

/** Python `str.islower` on a single character. */
function isLowerChar(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

/** `re.sub('[A-Z]', lambda x: '_' + x.group(0), name).split('_')`. */
export function splitCamel(name: string): string[] {
  return name.replace(/[A-Z]/g, ch => `_${ch}`).split('_');
}

/** Random string of the given length over the 52-letter alphabet. */
export function randomString(length: number, rng: Rng): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += UPPER_AND_LOWER[Math.floor(rng() * UPPER_AND_LOWER.length)]!;
  }
  return out;
}

/** True when the value contains at least one digit. */
export function isNumberString(value: string): boolean {
  return /[0-9]/.test(value);
}

/** True when the value contains any ASCII punctuation except '_'. */
export function hasSpecialString(value: string): boolean {
  for (const char of value) if (PUNCTUATION_EXCEPT_UNDERSCORE.has(char)) return true;
  return false;
}

/** UTF-8 md5 hex digest (node:crypto createHash). */
export function md5Hex(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

/** MD5 of the first 8096 bytes of a file. */
export function getFileMd5Value(buffer: Buffer): string {
  return createHash('md5').update(buffer.subarray(0, 8096)).digest('hex');
}

/** Draw a cleaned word from the lexicon pool. */
export function lexiconWord(rng: Rng): string {
  const index = Math.min(LEXICON.length - 1, Math.floor(rng() * LEXICON.length));
  let word = LEXICON[index] ?? '';
  if (word === 'virtual') word = 'virtualObj';
  return word === '' ? 'word' : word;
}

function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Whole-word swap of one identifier using `\b\w+\b` (matching the original `re.sub`). */
function replaceWord(text: string, name: string, obscured: string): string {
  if (!name) return text;
  return text.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), () => obscured);
}

// ---------------------------------------------------------------------------
// Naming rules (my-rule)
// ---------------------------------------------------------------------------

/** Generate an obscured class name via the my-rule algorithm. */
export function obscureClassNameByMyRule(name: string, _prefixWord: string, rng: Rng): string {
  let parts = splitCamel(name);
  const firstKeyWord = capitalize(lexiconWord(rng));
  let lastKeyWord: string;
  if (parts.length > 0 && parts[0]!.length === 0) {
    while (parts.length > 0 && parts[0]!.length === 0) parts = parts.slice(1);
  }
  if (parts.length > 0) {
    lastKeyWord = capitalize(parts[parts.length - 1]!);
  } else {
    lastKeyWord = capitalize(lexiconWord(rng));
  }
  const add: string[] = [firstKeyWord];
  let addCount = parts.length - 2;
  if (addCount <= 0) addCount = 1;
  for (let index = 0; index < addCount + randomInt(rng, 0, 1); index += 1) {
    add.push(capitalize(lexiconWord(rng)));
  }
  add.push(lastKeyWord);
  let result = add.join('');
  if (name.startsWith('_')) result = `_${result}`;
  return result;
}

/** Generate an obscured method name via the my-rule algorithm (dead branch omitted). */
export function obscureMethodNameByMyRule(name: string, prefixWord: string, rng: Rng): string {
  const parts = splitCamel(name);
  let firstKeyWord = lexiconWord(rng);
  if (prefixWord.length > 0 && !prefixWord.endsWith('_')) {
    firstKeyWord = capitalize(firstKeyWord);
  } else if (name.startsWith('_')) {
    void capitalize(lexiconWord(rng)); // draw consumed but overwritten by the original
  }
  const kept = parts.filter(item => item.length > 2);
  let lastKeyWord: string;
  if (kept.length > 0) {
    lastKeyWord = kept[kept.length - 1]!;
  } else {
    lastKeyWord = capitalize(lexiconWord(rng));
  }
  let result = firstKeyWord + capitalize(lexiconWord(rng)) + capitalize(lastKeyWord);
  if (name.startsWith('_')) result = `_${result}`;
  return result;
}

/** Generate an obscured variable/constant name via the my-rule algorithm. */
export function obscureVariableNameByMyRule(name: string, prefixWord: string, rng: Rng): string {
  const parts = splitCamel(name);
  let firstKeyWord = lexiconWord(rng);
  if (prefixWord.length > 0 && !prefixWord.endsWith('_')) {
    firstKeyWord = capitalize(firstKeyWord);
  } else if (name.startsWith('_')) {
    void capitalize(lexiconWord(rng)); // draw consumed but overwritten by the original
  }
  let lastKeyWord: string;
  if (parts.length > 0) {
    lastKeyWord = capitalize(parts[parts.length - 1]!);
  } else {
    lastKeyWord = capitalize(lexiconWord(rng));
  }
  let result = firstKeyWord + lastKeyWord;
  if (name.startsWith('_')) result = `_${result}`;
  return result;
}

/** Generate an obscured resource name via the my-rule algorithm. */
export function obscureResourceNameByMyRule(name: string, _prefixWord: string, rng: Rng): string {
  let parts = splitCamel(name);
  const firstKeyWord = lexiconWord(rng);
  let lastKeyWord: string;
  if (parts.length > 0 && parts[0]!.length === 0) {
    while (parts.length > 0 && parts[0]!.length === 0) parts = parts.slice(1);
  }
  if (parts.length > 0) {
    lastKeyWord = capitalize(parts[parts.length - 1]!);
  } else {
    lastKeyWord = capitalize(lexiconWord(rng));
  }
  const add: string[] = [firstKeyWord];
  let addCount = parts.length - 2;
  if (addCount <= 0) addCount = 1;
  for (let index = 0; index < addCount; index += 1) add.push(capitalize(lexiconWord(rng)));
  add.push(lastKeyWord);
  let result = add.join('');
  if (name.startsWith('_')) result = `_${result}`;
  return result;
}

// ---------------------------------------------------------------------------
// Full generators (prefix '#', whitelist, algorithm selection, case normalization)
// ---------------------------------------------------------------------------

function prefixHashReturn(prefix: string, name: string): string | undefined {
  if (prefix.endsWith('#')) return (prefix.split('#')[0] ?? '') + name;
  return undefined;
}

function finishGenerated(prefix: string, name: string, obscured: string): string {
  if (prefix.length > 0 && name.includes('_')) {
    if (prefix.endsWith('_') && name.startsWith('_')) return (prefix.split('_')[0] ?? '') + obscured;
    return prefix + obscured;
  }
  const first = obscured[0] ?? '';
  const rest = obscured.slice(1);
  const adjusted = isLowerChar(name[0] ?? '') ? first.toLowerCase() : first.toUpperCase();
  return prefix + adjusted + rest;
}

/** Generate an obscured class name (whitelist/prefix/algorithm selection). */
export function generateClassName(name: string, prefixWord: string, rng: Rng, options: NormalizedFlutterOptions): string {
  if (MUST_WHITE_CLASS_SET.has(name) || options.classWhiteList.includes(name)) return name;
  const hashed = prefixHashReturn(prefixWord, name);
  if (hashed !== undefined) return hashed;
  const obscured = options.missAlgorithmType === 3
    ? randomString(name.length * 2, rng)
    : obscureClassNameByMyRule(name, prefixWord, rng);
  return finishGenerated(prefixWord, name, obscured);
}

/** Generate an obscured method name (whitelist/prefix/algorithm selection). */
export function generateMethodName(name: string, prefixWord: string, rng: Rng, options: NormalizedFlutterOptions): string {
  if (IGNORE_METHOD_SET.has(name) || options.methodWhiteList.includes(name)) return name;
  const hashed = prefixHashReturn(prefixWord, name);
  if (hashed !== undefined) return hashed;
  const obscured = options.missAlgorithmType === 3
    ? randomString(name.length * 2, rng)
    : obscureMethodNameByMyRule(name, prefixWord, rng);
  return finishGenerated(prefixWord, name, obscured);
}

/** Generate an obscured variable/constant name (whitelist/prefix/algorithm selection). */
export function generateVariableName(name: string, prefixWord: string, rng: Rng, options: NormalizedFlutterOptions): string {
  if (IGNORE_VARIABLE_SET.has(name) || options.variableWhiteList.includes(name)) return name;
  const hashed = prefixHashReturn(prefixWord, name);
  if (hashed !== undefined) return hashed;
  const obscured = options.missAlgorithmType === 3
    ? randomString(name.length * 2, rng)
    : obscureVariableNameByMyRule(name, prefixWord, rng);
  return finishGenerated(prefixWord, name, obscured);
}

/** Generate an obscured resource name (prefix/algorithm selection). */
export function generateResourceName(name: string, prefixWord: string, rng: Rng, options: NormalizedFlutterOptions): string {
  const hashed = prefixHashReturn(prefixWord, name);
  if (hashed !== undefined) return hashed;
  const obscured = options.missAlgorithmType === 3
    ? randomString(name.length * 2, rng)
    : obscureResourceNameByMyRule(name, prefixWord, rng);
  return finishGenerated(prefixWord, name, obscured);
}

// ---------------------------------------------------------------------------
// Dart line analysis (declaration detection)
// ---------------------------------------------------------------------------

export interface DartClassMatch { name: string }
export interface DartMethodMatch { name: string }
export type DartVariableMatch = { kind: 'constructor'; names: string[] } | { kind: 'declaration'; name: string };

/** Class declaration analysis: a `class ` line returns the second token. */
export function analyzeDartClassLine(line: string): DartClassMatch | undefined {
  if (!line.startsWith('class ')) return undefined;
  const tokens = line.split(/\s+/).filter(Boolean);
  const name = tokens[1];
  return name ? { name } : undefined;
}

/** Method declaration analysis: a return-typed method declaration line. */
export function analyzeDartMethodLine(line: string): DartMethodMatch | undefined {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return undefined;
  const returnWord = tokens[0]!;
  if (!BASIC_DATA_SET.has(returnWord) && !BASIC_CONTROL_SET.has(returnWord)) return undefined;
  if (line.split('(').length - 1 !== 1 || line.split(')').length - 1 !== 1) return undefined;
  if (line.endsWith(';')) return undefined;
  const open = line.indexOf('(');
  if (open < 0) return undefined;
  const methodString = line.slice(2, open);
  const methodTokens = methodString.split(/\s+/).filter(Boolean);
  const name = methodTokens[methodTokens.length - 1];
  if (!name || hasSpecialString(name)) return undefined;
  if (IGNORE_METHOD_SET.has(name)) return undefined;
  if (name.startsWith('did') && name.endsWith('State')) return undefined;
  return { name };
}

/** Variable declaration analysis: variable / const-constructor declarations. */
export function analyzeDartVariableLine(line: string): DartVariableMatch | undefined {
  if (line.startsWith('//')) return undefined;
  const noSpace = line.trim();
  if (noSpace.length === 0) return undefined;

  if (noSpace.startsWith('const ') && noSpace.endsWith(');')) {
    const names = [...noSpace.matchAll(/this\.(\w+)/g)].map(match => match[1]!);
    return names.length > 0 ? { kind: 'constructor', names } : undefined;
  }

  if (!line.startsWith(' ')) return undefined;
  if (!line.endsWith(';')) return undefined;

  const tokens = noSpace.split(/\s+/).filter(Boolean);
  let name: string | undefined;

  const branchA = !line.includes('=') || line.includes('=>') || line.includes('==');
  if (branchA) {
    if (tokens.length < 2 || tokens.length > 3) return undefined;
    const first = tokens[0]!;
    if (!CONSTANT_KEYWORD_SET.has(first) && !BASIC_DATA_SET.has(first) && !BASIC_CONTROL_SET.has(first)) return undefined;
    name = tokens[tokens.length - 1];
    if (name !== undefined && name.includes(';')) name = name.slice(0, name.indexOf(';'));
    if (name !== undefined && (name.includes('({') || name.includes('('))) name = undefined;
    if (name !== undefined && (name.includes('})') || name.includes(')'))) name = undefined;
  } else {
    if (!line.includes('=')) return undefined;
    const eq = line.indexOf('=');
    if (line[eq - 1] !== ' ' || line[eq + 1] !== ' ') return undefined;
    const lhs = noSpace.split('=')[0]!.trim();
    const lhsTokens = lhs.split(/\s+/).filter(Boolean);
    if (lhsTokens.length <= 1) return undefined;
    name = lhsTokens[lhsTokens.length - 1];
  }

  if (!name) return undefined;
  return { kind: 'declaration', name };
}

// ---------------------------------------------------------------------------
// Whole-word line replacement (with the original string-literal protections)
// ---------------------------------------------------------------------------

/** Replace a class name on a line: plain `\b\w+\b` swap. */
export function replaceClassNameInLine(line: string, name: string, obscured: string): string {
  return replaceWord(line, name, obscured);
}

/** Replace a method name on a line, protecting `"name"` string literals. */
export function replaceMethodNameInLine(line: string, name: string, obscured: string): string {
  const mark = '$Z-F-J$';
  let work = line;
  if (work.includes(`"${name}"`)) work = work.split(`"${name}"`).join(mark);
  let result = replaceWord(work, name, obscured);
  if (result.includes(mark)) result = result.split(mark).join(`"${name}"`);
  return result;
}

/** Replace a variable/constant name on a line, protecting string/literal/call/regex forms. */
export function replaceVariableNameInLine(line: string, name: string, obscured: string): string {
  if (line.startsWith('import')) return line;
  const mark = '$Z-F-J$';
  const single = `'${name}'`;
  const call = `${name}(`;
  const slash = `/${name}/`;
  let work = line;
  const hadDouble = work.includes(`"${name}"`);
  const hadSingle = work.includes(single);
  const hadCall = work.includes(call);
  const hadSlash = work.includes(slash);
  if (hadDouble) work = work.split(`"${name}"`).join(mark);
  if (hadSingle) work = work.split(single).join(md5Hex(single));
  if (hadCall) work = work.split(call).join(md5Hex(call));
  if (hadSlash) work = work.split(slash).join(md5Hex(slash));
  let result = replaceWord(work, name, obscured);
  if (result.includes(mark)) result = result.split(mark).join(`"${name}"`);
  if (hadSingle) result = result.split(md5Hex(single)).join(single);
  if (hadCall) result = result.split(md5Hex(call)).join(call);
  if (hadSlash) result = result.split(md5Hex(slash)).join(slash);
  return result;
}

// ---------------------------------------------------------------------------
// Comment deletion
// ---------------------------------------------------------------------------

export interface DeleteNotesLineResult { text: string | null; inBlock: boolean }

/** Delete Dart comments from a single line (trailing newline already removed). */
export function deleteNotesInLine(line: string, inBlock: boolean): DeleteNotesLineResult {
  let noNotes: string | null = null;
  const stripped = line.trim();
  if (stripped.includes('//')) {
    const ds = line.indexOf('//');
    if (line.includes('"') && (line.split('"').length - 1) === 2) {
      const start = line.indexOf('"');
      const end = line.indexOf('"', start + 1);
      noNotes = ds > end ? line.slice(0, ds) : line;
    } else if (line.includes("'") && (line.split("'").length - 1) === 2) {
      const start = line.indexOf("'");
      const end = line.indexOf("'", start + 1);
      noNotes = ds > end ? line.slice(0, ds) : line;
    } else {
      noNotes = line.slice(0, ds);
    }
  } else if (stripped.includes('/*') && !stripped.includes('*/')) {
    noNotes = line.slice(0, line.indexOf('/*'));
    inBlock = true;
  } else if (!stripped.includes('/*') && stripped.includes('*/')) {
    noNotes = line.slice(line.indexOf('*/') + 2);
    inBlock = false;
  } else if (stripped.includes('/*') && stripped.includes('*/')) {
    const start = line.indexOf('/*');
    const end = line.indexOf('*/') + 2;
    const mark = line.slice(start, end);
    noNotes = line.split(mark).join('');
  } else if (inBlock && !stripped.includes('/*') && !stripped.includes('*/')) {
    noNotes = null;
  } else {
    noNotes = line;
  }

  if (noNotes !== null) {
    if (noNotes.replace(/ /g, '') === '') return { text: null, inBlock };
    return { text: noNotes, inBlock };
  }
  return { text: null, inBlock };
}

/** Python file-iteration semantics: each yielded line plus whether it carried a trailing newline. */
function pythonLines(source: string): Array<{ text: string; hasNewline: boolean }> {
  if (source === '') return [];
  const parts = source.split('\n');
  const result: Array<{ text: string; hasNewline: boolean }> = [];
  for (let index = 0; index < parts.length; index += 1) {
    result.push({ text: parts[index]!, hasNewline: index < parts.length - 1 });
  }
  if (result[result.length - 1]!.text === '' && !result[result.length - 1]!.hasNewline) result.pop();
  return result;
}

/** Delete Dart comments from a whole source file. */
export function deleteDartComments(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const { text, hasNewline } of pythonLines(source)) {
    const result = deleteNotesInLine(text, inBlock);
    inBlock = result.inBlock;
    if (result.text !== null && result.text.length > 0) out.push(result.text + (hasNewline ? '\n' : ''));
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Resource names and references
// ---------------------------------------------------------------------------

const FLUTTER_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const FLUTTER_AUDIO_EXTENSIONS = new Set(['pcm', 'wav', 'mp3', 'amr', 'aac', 'caf']);
const FLUTTER_VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'wmv', 'iso', 'rmvb']);

function fileExtension(relative: string): string {
  const base = relative.slice(relative.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 1 ? '' : base.slice(dot + 1).toLowerCase();
}

function basename(relative: string): string {
  return relative.slice(relative.lastIndexOf('/') + 1);
}

/** True for image files (extension paths only). */
export function isFlutterImage(relative: string): boolean {
  return FLUTTER_IMAGE_EXTENSIONS.has(fileExtension(relative));
}

/** True for audio files (by extension). */
export function isFlutterAudio(relative: string): boolean {
  return FLUTTER_AUDIO_EXTENSIONS.has(fileExtension(relative));
}

/** True for video files (by extension). */
export function isFlutterVideo(relative: string): boolean {
  return FLUTTER_VIDEO_EXTENSIONS.has(fileExtension(relative));
}

const IGNORE_IMAGE_PATHS = ['/build/', '/ios/Runner/', '/.', '/android/app/'];

/** True for image paths that should be ignored. */
export function isIgnoreImgPath(relative: string): boolean {
  return IGNORE_IMAGE_PATHS.some(item => relative.includes(item));
}

const MUST_IGNORE_PATHS = ['/.git/', '/Pods/', '/README.md', '/Podfile.lock', '.json', '/.DS_Store', '/.svn/'];

/** True for project-relative paths that must be ignored. */
export function mustIgnorePath(relative: string): boolean {
  const withSlash = `/${relative}`;
  return MUST_IGNORE_PATHS.some(item => withSlash.includes(item) || relative.includes(item));
}

const DART_RESOURCE_PATTERNS = (name: string): string[] => [
  `/${name}.`,
  `'${name}.`,
  `"${name}.`,
  ` ${name}.`,
  `'${name}.',`,
  `"${name}.",`,
];

const YAML_RESOURCE_PATTERNS = (name: string): string[] => [`/${name}.`, `-${name}.`, ` ${name}.`];

/** Rewrite resource references in a Dart source file. */
export function rewriteDartResourceReferences(source: string, map: ReadonlyMap<string, string>): string {
  return source.split('\n').map(line => {
    let result = line;
    for (const [name, obscured] of map) {
      for (const pattern of DART_RESOURCE_PATTERNS(name)) {
        if (result.includes(pattern)) {
          result = result.split(pattern).join(pattern.replace(name, obscured));
          break;
        }
      }
    }
    return result;
  }).join('\n');
}

/** Rewrite resource references in a YAML file. */
export function rewriteYamlResourceReferences(source: string, map: ReadonlyMap<string, string>): string {
  return source.split('\n').map(line => {
    let result = line;
    for (const [name, obscured] of map) {
      for (const pattern of YAML_RESOURCE_PATTERNS(name)) {
        if (result.includes(pattern)) {
          result = result.split(pattern).join(pattern.replace(name, obscured));
          break;
        }
      }
    }
    return result;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Resource hash perturbation
// ---------------------------------------------------------------------------

const HASH_PAD_CHARS = '#&';

/** First hash-pad character: always '#'. */
export function firstRandomCode(): string {
  return '#';
}

/** Hash-pad string: '#' + (length + 1) chars from '#&'. */
export function randomCodeString(length: number, rng: Rng): string {
  let final = HASH_PAD_CHARS[Math.floor(rng() * 2)]!;
  for (let index = 0; index < length; index += 1) final += HASH_PAD_CHARS[Math.floor(rng() * 2)]!;
  return firstRandomCode() + final;
}

/** Deterministic `#&` suffix appended to a resource payload to change its md5. */
export function perturbResourceHash(buffer: Buffer, seed: string, salt: string): Buffer {
  const rng = seededRandom(deriveHash(seed, 'flutter-resource-hash', salt));
  return Buffer.concat([buffer, Buffer.from(randomCodeString(4, rng), 'latin1')]);
}

// ---------------------------------------------------------------------------
// project.pbxproj UUID remapping
// ---------------------------------------------------------------------------

/** True for a 24-char uppercase Xcode UUID with no `/* ="._{}`. */
export function isXcodeUuid(token: string): boolean {
  if (token.length !== 24) return false;
  if (!/[A-Z]/.test(token) || token !== token.toUpperCase()) return false;
  return !/[\/\* ="._{}]/.test(token);
}

/** Remap project.pbxproj UUIDs, pure over a source string. */
export function remapPbxprojUuids(source: string, seed: string): string {
  const map = new Map<string, string>();
  for (const line of source.split('\n')) {
    let token = line.replace(/\s+/g, '');
    if (token.length >= 24) token = token.slice(0, 24);
    if (isXcodeUuid(token) && !map.has(token)) map.set(token, deriveUuid(seed, token));
  }
  if (map.size === 0) return source;
  let result = source;
  for (const [oldUuid, newUuid] of map) result = result.split(oldUuid).join(newUuid);
  return result;
}

// ---------------------------------------------------------------------------
// Internal orchestration helpers
// ---------------------------------------------------------------------------

function dartFiles(files: WalkEntry[]): WalkEntry[] {
  return files.filter(entry => entry.relative.endsWith('.dart') && !mustIgnorePath(entry.relative));
}

function splitLines(source: string): string[] {
  return source.split('\n');
}

/**
 * Discovery + whole-word rewrite for one symbol kind over all dart files. Mirrors the
 * original `save_*_name` collision handling: generate once, and regenerate exactly once
 * when the result was already used; ignored/whitelisted names return unchanged and do not
 * advance the random stream.
 */
function runSymbolPass(
  files: WalkEntry[],
  rng: Rng,
  analyze: (line: string) => string[],
  generate: (name: string, rng: Rng) => string,
  rewrite: (line: string, map: Map<string, string>) => string,
  changedPaths: Set<string>,
): number {
  const entries = dartFiles(files);
  const map = new Map<string, string>();
  const used: string[] = [];

  for (const entry of entries) {
    const source = readFileSync(entry.absolute, 'utf8');
    for (const line of splitLines(source)) {
      for (const name of analyze(line)) {
        if (map.has(name)) continue;
        let obscured = generate(name, rng);
        if (obscured === name) continue;
        if (used.includes(obscured)) obscured = generate(name, rng);
        used.push(obscured);
        map.set(name, obscured);
      }
    }
  }

  if (map.size === 0) return 0;
  let changed = 0;
  for (const entry of entries) {
    const before = readFileSync(entry.absolute, 'utf8');
    const after = splitLines(before).map(line => rewrite(line, map)).join('\n');
    if (after !== before && writeIfChanged(entry, after)) {
      changed += 1;
      changedPaths.add(entry.relative);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Batch entry point
// ---------------------------------------------------------------------------

/**
 * In-place Flutter obfuscation over an already-walked project, following the original
 * `flutter_obscure_main` order: variable -> class -> method -> resource hash -> resource
 * name -> delete notes -> uuid. Each symbol pass discovers declarations across all dart
 * files first (deterministically, sorted by relative path) and then rewrites every
 * occurrence using the original whole-word rules.
 */
export function renameFlutterSymbols(files: WalkEntry[], options: FlutterOptions, seed: string): TransformOutcome {
  const opts = normalizeFlutterOptions(options);
  const rng = seededRandom(deriveHash(seed, 'flutter'));
  const sorted = [...files].sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  const changedPaths = new Set<string>();
  let unsupported = 0;

  // variable
  if (opts.features.variable) {
    runSymbolPass(sorted, rng,
      line => {
        const match = analyzeDartVariableLine(line);
        if (!match) return [];
        return match.kind === 'constructor' ? match.names : [match.name];
      },
      (name, r) => generateVariableName(name, opts.prefixWord, r, opts),
      (line, map) => {
        let result = line;
        for (const [name, obscured] of map) result = replaceVariableNameInLine(result, name, obscured);
        return result;
      },
      changedPaths);
  }

  // class
  if (opts.features.className) {
    runSymbolPass(sorted, rng,
      line => {
        const match = analyzeDartClassLine(line);
        return match ? [match.name] : [];
      },
      (name, r) => generateClassName(name, opts.prefixWord, r, opts),
      (line, map) => {
        let result = line;
        for (const [name, obscured] of map) result = replaceClassNameInLine(result, name, obscured);
        return result;
      },
      changedPaths);
  }

  // method
  if (opts.features.method) {
    runSymbolPass(sorted, rng,
      line => {
        const match = analyzeDartMethodLine(line);
        return match ? [match.name] : [];
      },
      (name, r) => generateMethodName(name, opts.prefixWord, r, opts),
      (line, map) => {
        let result = line;
        for (const [name, obscured] of map) result = replaceMethodNameInLine(result, name, obscured);
        return result;
      },
      changedPaths);
  }

  // resource hash (append a deterministic '#&' pad to image/audio/video payloads)
  if (opts.features.resourceHash) {
    for (const entry of sorted) {
      if (!isFlutterImage(entry.relative) && !isFlutterAudio(entry.relative) && !isFlutterVideo(entry.relative)) continue;
      if (mustIgnorePath(entry.relative)) continue;
      const before = readFileSync(entry.absolute);
      const after = perturbResourceHash(before, seed, entry.relative);
      if (after.equals(before)) continue;
      writeFileSync(entry.absolute, after);
      changedPaths.add(entry.relative);
    }
  }

  // resource name: discover image stems (non-numeric, not ignored), rewrite dart/yaml references, rename files
  if (opts.features.resourceName) {
    const nameMap = new Map<string, string>();
    const used: string[] = [];
    const renames = new Map<string, string>();
    for (const entry of sorted) {
      if (!isFlutterImage(entry.relative) || isIgnoreImgPath(entry.relative)) continue;
      const base = basename(entry.relative);
      const dot = base.indexOf('.');
      const resourceName = dot < 0 ? base : base.slice(0, dot);
      const resourceType = dot < 0 ? '' : base.slice(base.lastIndexOf('.') + 1);
      if (isNumberString(resourceName)) continue;
      if (!nameMap.has(resourceName)) {
        let obscured = generateResourceName(resourceName, opts.prefixWord, rng, opts);
        if (used.includes(obscured)) obscured = generateResourceName(resourceName, opts.prefixWord, rng, opts);
        used.push(obscured);
        nameMap.set(resourceName, obscured);
      }
      const obscured = nameMap.get(resourceName)!;
      const oldPath = entry.absolute;
      const newPath = oldPath.split(`${resourceName}.${resourceType}`).join(`${obscured}.${resourceType}`);
      if (newPath !== oldPath) renames.set(oldPath, newPath);
    }

    // rewrite references first, then move files (original traverses all directories here)
    for (const entry of sorted) {
      if (entry.relative.endsWith('.dart')) {
        if (entry.relative.includes('/.')) continue;
        const before = readFileSync(entry.absolute, 'utf8');
        const after = rewriteDartResourceReferences(before, nameMap);
        if (after !== before && writeIfChanged(entry, after)) changedPaths.add(entry.relative);
      } else if (entry.relative.endsWith('.yaml')) {
        const before = readFileSync(entry.absolute, 'utf8');
        const after = rewriteYamlResourceReferences(before, nameMap);
        if (after !== before && writeIfChanged(entry, after)) changedPaths.add(entry.relative);
      }
    }
    for (const [from, to] of renames) {
      try {
        renameSync(from, to);
        changedPaths.add(to);
      } catch {
        unsupported += 1;
      }
    }
  }

  // delete notes
  if (opts.features.deleteNotes) {
    for (const entry of dartFiles(sorted)) {
      const before = readFileSync(entry.absolute, 'utf8');
      const after = deleteDartComments(before);
      if (after !== before && writeIfChanged(entry, after)) changedPaths.add(entry.relative);
    }
  }

  // uuid
  if (opts.features.uuid) {
    for (const entry of sorted) {
      if (!entry.relative.endsWith('project.pbxproj')) continue;
      const before = readFileSync(entry.absolute, 'utf8');
      const after = remapPbxprojUuids(before, seed);
      if (after !== before && writeIfChanged(entry, after)) changedPaths.add(entry.relative);
    }
  }

  return { changed: changedPaths.size, changedPaths: [...changedPaths].sort(), unsupported };
}
