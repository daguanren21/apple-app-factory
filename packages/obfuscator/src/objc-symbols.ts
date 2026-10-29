import { readFileSync } from 'node:fs';
import type { TransformOutcome, WalkEntry } from './common.js';
import { deriveHash, extension, seededRandom, writeIfChanged } from './common.js';

/**
 * Deterministic Objective-C & Swift symbol renamer. Qt GUI, SQLite, networking,
 * licensing and nltk/wordnet lookups are dropped. All randomness flows through
 * the seeded PRNG in common.js, so a given seed always produces the same output.
 */

const LEXICON: readonly string[] = ['application', 'architecture', 'argument', 'array', 'arrow', 'assembly', 'assign', 'assignment', 'associated', 'associative', 'atomic', 'attribute', 'audio', 'background', 'backward', 'bandwidth', 'base', 'batch', 'benefit', 'best', 'binary', 'binding', 'bitmap', 'bitwise', 'block', 'boolean', 'border', 'breakpoint', 'build', 'bus', 'business', 'buttons', 'byte', 'cache', 'call', 'callback', 'candidate', 'chain', 'character', 'check', 'checked', 'child', 'cleanup', 'client', 'clipboard', 'clone', 'collection', 'combo', 'command', 'communication', 'compatible', 'compile', 'compiler', 'component', 'composition', 'computer', 'concept', 'concrete', 'concurrent', 'configuration', 'connection', 'constraint', 'construct', 'container', 'containment', 'context', 'control', 'console', 'const', 'constant', 'copy', 'cover', 'create', 'creation', 'cursor', 'custom', 'data', 'database', 'datagram', 'dead', 'debug', 'debugger', 'declaration', 'deduction', 'default', 'defer', 'define', 'definition', 'delegate', 'delegation', 'demarshal', 'dereference', 'derived', 'design', 'destroy', 'destructor', 'device', 'dialog', 'directive', 'directory', 'disk', 'dispatch', 'distributed', 'document', 'dot', 'driver', 'dynamic', 'efficiency', 'efficient', 'end', 'entity', 'encapsulation', 'enclosing', 'enum', 'enumerators', 'equal', 'equality', 'equivalence', 'equivalent', 'escape', 'evaluate', 'event', 'exception', 'explicit', 'export', 'expression', 'facility', 'feature', 'field', 'file', 'firmware', 'flag', 'flash', 'flexibility', 'flush', 'font', 'form', 'formal', 'forward', 'forwarding', 'fractal', 'framework', 'full', 'function', 'functionality', 'functor', 'game', 'generate', 'generic', 'getter', 'global', 'group', 'guard', 'gui', 'hand', 'handle', 'handler', 'hard', 'hardware', 'hash', 'header', 'heap', 'hierarchy', 'hook', 'hyperlink', 'icon', 'ide', 'identifier', 'illinois', 'image', 'immediate', 'immutability', 'immutable', 'implement', 'implementation', 'implicit', 'import', 'increment', 'infinite', 'information', 'infrastructure', 'inheritance', 'inline', 'initialization', 'initialize', 'inner', 'instance', 'instantiated', 'instantiation', 'integer', 'integrate', 'interacts', 'interface', 'for', 'interpreter', 'invariants', 'invoke', 'iterate', 'iterative', 'iterator', 'iteration', 'item', 'laser', 'level', 'library', 'lifetime', 'link', 'linker', 'literal', 'load', 'loader', 'local', 'lock', 'loop', 'lvalue', 'macro', 'magic', 'maintain', 'manipulator', 'marshal', 'mechanism', 'member', 'memberwise', 'memory', 'menu', 'message', 'method', 'micro', 'middleware', 'modeling', 'modem', 'module', 'modifier', 'most', 'mouse', 'mutable', 'namespace', 'native', 'nested', 'network', 'object', 'online', 'opaque', 'operand', 'operating', 'operation', 'operator', 'option', 'ordinary', 'overflow', 'overhead', 'overload', 'overloaded', 'override', 'package', 'pair', 'palette', 'pane', 'parallel', 'parameter', 'parent', 'parentheses', 'parse', 'part', 'partial', 'pass', 'pattern', 'performance', 'persistence', 'pixel', 'placement', 'platform', 'pointer', 'poll', 'polymorphism', 'pop', 'port', 'postfix', 'precedence', 'prefix', 'preprocessor', 'prime', 'primitive', 'print', 'printer', 'priority', 'procedure', 'procedural', 'process', 'profile', 'profiler', 'programmer', 'programming', 'progress', 'project', 'property', 'protocol', 'pseudo', 'qualified', 'qualifier', 'quality', 'queue', 'radian', 'radio', 'raise', 'random', 'rank', 'raw', 'record', 'recordset', 'recursive', 'refactoring', 'refer', 'reference', 'register', 'reflection', 'relational', 'represent', 'resolve', 'resolution', 'restriction', 'return', 'robust', 'robustness', 'routine', 'runtime', 'common', 'rvalue', 'save', 'schedule', 'scheduler', 'scheme', 'scroll', 'scope', 'screen', 'search', 'semantics', 'sequential', 'server', 'serial', 'serialization', 'setter', 'signal', 'signature', 'slider', 'slot', 'smart', 'snapshot', 'specialization', 'specification', 'splitter', 'software', 'solution', 'source', 'stack', 'standard', 'statement', 'status', 'stl', 'stream', 'string', 'subroutine', 'subscript', 'subtype', 'support', 'suspend', 'symbol', 'syntax', 'tag', 'target', 'task', 'template', 'temporary', 'text', 'thread', 'throw', 'token', 'transaction', 'traverse', 'trigger', 'type', 'uml', 'unary', 'underflow', 'unchecked', 'unqualified', 'unwinding', 'user', 'variable', 'vector', 'viable', 'video', 'view', 'virtual', 'volatile', 'vowel', 'window', 'word', 'wrapper', 'abstract', 'abstraction', 'access', 'account', 'action', 'activate', 'active', 'actual', 'adapter', 'address', 'adl', 'advanced', 'aggregation', 'algorithm', 'alias', 'align', 'allocate', 'angle', 'annotation', 'api', 'app', 'appearance', 'append', 'archive', 'asynchronous', 'authentication', 'authorization', 'backup', 'bcl', 'bookkeeping', 'bounds', 'boxing', 'brace', 'bracket', 'browser', 'bug', 'through', 'calendar', 'cascading', 'casting', 'catalog', 'checkpoint', 'cil', 'class', 'classification', 'clause', 'code', 'cli', 'cls', 'coff', 'com', 'comment', 'commit', 'composite', 'concurrency', 'constructor', 'cookie', 'corba', 'crosstab', 'crtp', 'cts', 'cube', 'dataset', 'dbms', 'dcom', 'deallocate', 'decay', 'decision', 'declarative', 'dependent', 'deploy', 'dhtml', 'digest', 'digital', 'dime', 'dirty', 'disassembler', 'disco', 'dispid', 'dna', 'dom', 'dtd', 'dump', 'eai', 'ebco', 'edi', 'engine', 'error', 'exclusive', 'evidence', 'exit', 'fat', 'fetch', 'filter', 'finalization', 'firewall', 'finalizer', 'foreign', 'fragmentation', 'gac', 'genericity'];

export const FILTER_CLASS_NAME_LIST: readonly string[] = ['TabBarController', 'AppDelegate', 'ViewController', 'UINavigationController', 'NavigationController', 'ScriptMessageHandler', 'CollectionViewFlowLayout', 'main', 'CoreBle', 'Photo', 'Manager'];

const FILTER_LIST_A: readonly string[] = 'enable scale URL supportsTextureSampleCount writeToFile code zoomScale direction videoGravity textLabel anonymous progress failure cancel block time enabled drawRect flashMode newCommandQueueWithMaxCommandBufferCount animateTransition secureTextEntry mediaType fileType device animation value draw commit play pause hide version locale parentController credential affinity listContainerView transitionDuration day context accessoryType detailText identifier object length path array queue beginTime timer configuration notify interval isEqual UUID timeRange createdAt containerSize url parameters player session pickerView row bridge section hidden badgeValue spacing rowHeight systemVersion ScriptMessage toURL quality logout hints uuid apple cache list selectIndex string isSelected fillColor cornerRadius masksToBounds borderColor delay receiver placeholderText timeZone archiveRootObject exponent widthIs heightIs regularExpression sureBtn param isPlaying itemSize inputView filter strokeColor state latitude longitude types attributed suspend inTransaction protocol seekToTime paused loadImage localizable standard webView button label orientation objects resources meta index completion attributedText bounces animationDuration goBack goForward operationType lastPathComponent loopMode animationImages begin LocationManager response config lineSpacing lineHeight customView backgroundView volume MD5 animationRepeatCount exposureMode appID encode lossless sel topItem asset reset manager userInfo top params date components sectionInset actions line borderUIColor selector scheme location request openURL executing finished beginAppearanceTransition origin isRecording totalCount totalCost writer totalSize read beginUpdates String after endIndex reduce schedule refresh convert isFileURL accessibilityLabel combine valueChanged named canEditRowAt insets torchMode cancelled task jpushNotificationCenter layoutMargins evaluateJavaScript dateFromString withString handlers calendar cancelExport selectItem rounded editingStyleForRowAt awakeFromNib alertControllerWithTitle allocWithZone init drawMode sourceType substring dispose unarchiveObjectWithFile preferHDAudio username loopCount union endAppearanceTransition actionWithTitle alert track create resume prepareForReuse dismiss normalColor selectColor repeating fromJSON voiceDetect onSuccess onError reversed cgPath grouped configurations dateFormat beginRefreshing endRefreshing refreshing compare stringFromDate visibleCells video progressBlock rotationAngle isTouchInside CC_DLL isNegative sizing voiceToText beforeSend completed instance pathForResource loadRequest loadHTMLString completionHandler long options color lock unlock format body description streamError query openLog userSig resignFirstResponder valueForHTTPHeaderField FBlock textAlignment memberNumber hangup cityEntity drawableSize texture screen presentsWithTransaction pixelFormat framebufferOnly role isCancelled item toView bundle values placeholderImage targetId tapGesture handler hidesForSinglePage country postNotification right lineHeightMultiple textContainer layoutManager textStorage items phoneNumber thumbnail isAnimating rightView progressView searchBar pageControl segmentedControl resultBlock objectAtIndex highlightedColor md5 synchronize maskView audioDenoise trackTimerStart trackTimerEnd notificationWithName localizedDescription _id playerView highlighted speed md5HashOfData requestAuthorization NobleInfo nobleInfo displayAvailable struct callback newRequest onReceive conversationType userId userID completionBlock openid window navigationController selectRow inDatabase timeInterval autoDeactivateAudioSession decodeForDisplay allowPickingOriginalPhoto muted StatusBarStyle refreshControl editable countLimit region coordinate mediaTypes stringValue thumbImage avatar sort prefersStatusBarHidden dealloc const method createDirectory linkTextAttributes selectable clearsOnInsertion textContainerInset second notification invalidate exit radius opacity readOptions canGoBack canGoForward exportAsynchronouslyWithCompletionHandler animations rect save change makeImage makeNSView makeUIView colorWithRed createDirectoryAtPath panGestureRecognizer gestureRecognizer editing password mode uid weixin_no order_by crc32 completeTransition cost screenX screenY screenViewX screenViewY screenFrame allKeys objc_setAssociatedObject moveItemAtURL constraintForView batteryLevel children push_back objectForKeyedSubscript totalTime close bind connect cocos2d isOn weekday hour minute second objc weixinAuthLoginInContext qqAuthLoginWithDelegate presentDrawable nextDrawable sorted batteryMonitoringEnabled defaultCenter clearCache round fullResolutionImage blue red green now implementationLayer encoding fileName topLeft layer paragraphStyle zero groupId groupID groupid'.split(' ');

const FILTER_LIST_B: readonly string[] = 'int reason bytes endDate mute one focusMode running sessionPreset timeStamp portraitUri groupName extra labelText weight userName objectName operation topRight displayName nickName gender birthday nickname headerImageView once minSize margin timestamp quitAfterComment commentId starValue resolveStatus sourceUserId transform phoneNumbers clear alpha appendBytes exp phone level_id email write matrix find shake complete notificationWithOperation parse times log sum empty debuggerVacateOpen executeUpdate recordedDuration requestImageWithURL source loadData executeQuery layout managedObjectContext end attributes timeoutInterval cachePolicy attribute baseURL port statusCode arguments lineWidth lineCap timingFunction products whiteBalanceMode kickUsers endUpdates statusBarStyle videoMaximumDuration progressHandler networkAccessAllowed equalTo fail reuseIdentifier priority normalize false true next reverse order loop first frames awake errno std function capacity evutil_socket_geterror leading trailing custom property xml trigger locations continuous emotionOriginalURL connection magic sectionTitles background emotionType inView emotionOriginalURL sampleRate category translation price isValid headerReferenceSize footerReferenceSize ext backgroundImage city subject province searchDisplayController appKey host failureBlock cls pageIndex pageNum horizontal isHidden weak coverImage networkActivityIndicatorVisible launchOptions event info leading price experience leftMargin rightMargin topMargin leadingMargin trailingMargin strong where alias login edges menuRightMargin triangleY triangleRightMargin triangleSize otherMargin beginMargin endMargin for seq subtitle openId sign stack isSuccess buttonWithType scene Double metrics copyWithZone endEditing defaultManager selectItemAtIndexPath encodeWithCoder authorizationStatus product loadingView invite_code resourceLoader exportSessionWithAsset final mask distance subscriber deselectItemAtIndexPath dictionaryRepresentation pagingEnabled team_scale compressQuality netStatus Finish platform faceView tableView Array readData rotated copyItem decelerationRate isLoading accessoryView language baseline superview selectionStyle successBlock hidesBottomBarWhenPushed lineJoin colors endPoint indicatorColor parentVC propertyName socks5Type page accessoryData fromType result scheduleRule comment customizedId menu inputAccessoryView privilege containerView backSpaceButtonImage intrinsicContentSize accessibilityValue mAveragePower mPeakPower badge msg DelayTime categories lineColor isFirstResponder becomeFirstResponder constraint inset downloadImageWithURL isWXAppSupport scaleToSize colorWithHexString Clear resetOffsetFromCenter popActivity bounds responseSerializer acceptableContentTypes requestSerializer strokeEnd lineBreakMode vertical hudType customImage indicatorBackGroundColor acceptableStatusCodes readingOptions automaticallyInflatesResponseImage videoPath cancelAllOperations appendData dictionary model icon user photo controlView rate bezierPath clearMemory arrayWithArray streamStatus limit post AssetsManagerEx undoManager scheduledTimerWithTimeInterval attributeText fillWithData suspended operations serverTrust fromValue toValue inviterAccid cacheKeyForURL socks5Addr nextObject sorted stretch value_type keyPath system area resourcePath decode failed unsigned operator revents events auto listen shutdown map Quaternion override AffineTransform Rect totalUnitCount nibWithNibName topAnchor activityItems process datePickerMode datePicker alignmentMode detailsLabel administrativeArea locality thoroughfare subLocality horizontalEdgeLength enablesReturnKeyAutomatically JSONObjectWithData async isDirectory adSize render uint BytesSize serializer subThoroughfare callStatus groupMemberDataSource videoView dateInterval daterRange transactions fetchRequest audioMix videoComposition reader posterImage propertyType blueColor EVP_CIPHER buffer myself multiplier BN_ULONG switch disconnect cachedResponseForRequest JSONString jsonString FFTSetup Sticker pauseRecord willRotateToInterfaceOrientation GetSize collection localIdentifier socket tree searchTextField camera audioMuted backItem isEditing parent videoOrientation endTime lastInsertRowId names active isOriginal handleOpenURL handleOpenUniversalLink openWXApp toDate isExist _block textValue rectOfInterest metadataObjectTypes hideHUDForView ins nib beautyLevel totleTime invalidateLayout clearDiskOnCompletion willAnimateRotationToInterfaceOrientation navigationBarHidden navigationBar repeats dragging statusBarHidden beautyLevel ruddinessLevel isReceived lineViewWithFrame unreadCount outputImage placeholderColor videoAsset videoResolution decompress m_frictionIndex lineView timeLabel avatarView expirationTimeInGMTFormat onNewMessage conversationData onlineUserOnly inviter clockwise convData hCenter vCenter listView listScrollView pagerView fetchOne applyTransform reachabilityStatusChangeBlock targetSize provider objectId columnNumber presetName isRunning frameCount outputURL URLCache creationDate videoSettings outputSettings attributedTitle atIndex fromView inSection diskCache isVisible pixelWidth pixelHeight md5String columnExists xmlChar prefix noMoreData frameOfPresentedViewInContainerView truncationToken releaseToRefresh refreshSuccess refreshFailure myNetworkLoggerPlugin'.split(' ');

export const FILTER_LIST: readonly string[] = [...FILTER_LIST_A, ...FILTER_LIST_B];

export const FILTER_MUST_IGNORE_METHOD_AND_PROPERTY_LIST: readonly string[] = 'select realloc const swap move pop sqrtf Free operator Init Key Vec2 reserve retain release erase append fastSet resize continue uLong uInt Bytef intValue floatValue step detach value Value Point point interactive replace edge intValue uncompress push rewind strcasecmp eof flush main back rotation npos Type resize random arc4random pointer reference Position position timeval mData self epsilon uLongf itemWidth pointSize snapshot acceleration fixed abort args base iconv_close force isAnalog isPressed _Nonnull Nonnull valueOptions interface isKindOfClass BackgroundColor backgroundColor effect infoDictionary foregroundColor extent statusBarFrame error key applyLayoutAttributes record fireDate headers cancelButtonTitle methodSignature returnValue dynamic superclass userContentController frame float and front double const doubleValue free copy from open leftView year month height width padding familyName itemForTag text textColor duration count type success title class name keyboardType borderWidth target tag left offset placeholder status alignment action delegate style lessThanOrEqualTo Group nil model leftBarButtonItem rightBarButtonItem assign extension constant opaque nextResponder statusBarOrientation navigationItem safeAreaInsets option userInterfaceStyle attributedPlaceholder physicalMemory transitionCoordinator translucent colorSpace givenName Height Width anchorPoint id ID switcher disableActions traitCollection nativeScale repeatCount resourceValue range BOOL bool load mix flags className tabBarItem tabBar tabBarController tabBarItemsAttributes __nullable Nullable _Nullable null _Nonnull fontSize fontName font SEL touchesBegan touchesEnded titleColor titleView titleLabel titleSelectedColor titles titleForState titleTextAttributes titlePositionAdjustment titleShadowColor TitleColor titleEdgeInsets titleFont keyword keyWords addSubview layoutSubviews subviews destination keyboardAppearance keyWindow domain observeValueForKeyPath snapshotView blockOperationWithBlock colorSpace contentOffset document firstResponder brightness isTracking cornerRadii statusBarManager playCommand pauseCommand cameraFlashMode cameraDevice prefix suffix href node properties childViewControllers owner windowScene dateComponents done subscription blur newValue cgImage layerClass sampleData container footerView headerView plugins break longValue appearance available restarted enabledConsoleLog sockaddr isExecuting isFinished pathExtension conditions convertPoint convertRect seekToOffset readDataOfLength writeData signal broadcast allHeaderFields exporter runsForEachTargetApplicationUIConfiguration stroke UTF8String stringFromNumber required default enum weekOfYear weekOfMonth weekdayOrdinal itemSpacing with lineFragmentPadding marker if_data rawValue identity keys distribution documentDirectory isEnabled compressionQuality isEmpty ciImage Data deviceMotionUpdateInterval pixelBuffer machine matches contains last actionSheet defaults oldValue searchController bytesPerRow mediaBox superlayer connections devices level ports enumerator lensPosition deviceWhiteBalanceGains activeFormat high autoFocus results mtlDevice commandBuffer targetContentOffset velocity canBecomeFirstResponder minimumValue autoscroll pitch gravity roll isHighlighted baseAddress animate supportedInterfaceOrientations shouldAutorotate preview queryItems isReady isAsynchronous targetFrame oldValue span intersection cachesDirectory undoManager hexString service uuidString scaleX jsonObject errCode absoluteString before appendString windows listener desc dict isReachable diskCapacity securityPolicy firstWeekday component identifierForVendor gestureRecognizerShouldBegin'.split(' ');

export const FILTER_MUST_IGNORE_METHOD_LIST: readonly string[] = 'viewDidLoad viewWillDisappear viewWillAppear layoutSubviews viewDidLayoutSubviews forwardInvocation scrollViewDidScroll awakeFromNib willMoveToSuperview drawTextInRect drawRect dealloc load layerClass performBatchUpdates md5String columnExists writeData debugDescription'.split(' ');

function pyCapitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

function pyTitle(s: string): string {
  return pyCapitalize(s);
}

function upperFirst(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

function pyIsTitle(s: string): boolean {
  if (s.length === 0) return false;
  if (!(s[0]! >= 'A' && s[0]! <= 'Z')) return false;
  for (let i = 1; i < s.length; i += 1) if (s[i]! >= 'A' && s[i]! <= 'Z') return false;
  return true;
}

function pyIsUpper(s: string): boolean {
  return s.length > 0 && /^[A-Z]+$/.test(s);
}

function pyIsDigit(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

export type MissAlgorithmType = 0 | 1 | 3;

export interface ObjcMagicColorOptions {
  enabled?: boolean;
  addColor?: number;
  textColor?: number;
  replaceColor?: readonly [number, number, number];
  alpha?: readonly [number, number];
}

export interface ObjcSymbolsOptions {
  algorithmType?: MissAlgorithmType;
  methodPrefix?: string;
  methodSuffix?: string;
  propertyPrefix?: string;
  classPrefix?: string;
  replaceClassPrefix?: { from: string; to: string };
  replaceMethodPrefix?: { from: string; to: string };
  replacePropertyPrefix?: { from: string; to: string };
  magicColor?: ObjcMagicColorOptions;
  fileExtensions?: readonly string[];
}

interface SeededRng {
  next(): number;
  randInt(min: number, max: number): number;
  choice<T>(values: readonly T[]): T;
}

function createRng(seed: string): SeededRng {
  const random = seededRandom(deriveHash(seed, 'objc-symbols'));
  return {
    next: random,
    randInt(min, max) { return min + Math.floor(random() * (max - min + 1)); },
    choice(values) { return values[Math.floor(random() * values.length)]!; },
  };
}

interface RenameContext {
  options: ObjcSymbolsOptions;
  seed: string;
  rng: SeededRng;
  methodMap: Map<string, string>;
  propertyMap: Map<string, string>;
  classMap: Map<string, string>;
  temporaryPropertyNames: Set<string>;
  allMissClassNames: Set<string>;
  projectNames: string[];
}

export function createRenameContext(options: ObjcSymbolsOptions = {}, seed: string): RenameContext {
  return {
    options,
    seed,
    rng: createRng(seed),
    methodMap: new Map(),
    propertyMap: new Map(),
    classMap: new Map(),
    temporaryPropertyNames: new Set(),
    allMissClassNames: new Set(),
    projectNames: [],
  };
}

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomStringNoNumber(num: number, ctx: RenameContext): string {
  let salt = '';
  for (let i = 0; i < num; i += 1) salt += ALPHA[ctx.rng.randInt(0, ALPHA.length - 1)]!;
  return salt;
}

function randomWordFromLexicon(ctx: RenameContext): string {
  let word = ctx.rng.choice(LEXICON);
  word = word.replace(/\n/g, '');
  if (word === 'virtual') word = 'virtualObj';
  word = word.replace(/ /g, '').replace(/"/g, '');
  if (word.length === 0) word = 'word';
  return word;
}

export function isContainChinese(text: string): boolean {
  for (const ch of text) if (ch >= '\u4e00' && ch <= '\u9fff') return true;
  return false;
}

const PINYIN: Readonly<Record<string, string>> = {
  一: 'Yi', 二: 'Er', 三: 'San', 四: 'Si', 五: 'Wu', 六: 'Liu', 七: 'Qi', 八: 'Ba', 九: 'Jiu', 十: 'Shi',
  中: 'Zhong', 文: 'Wen', 上: 'Shang', 下: 'Xia', 大: 'Da', 小: 'Xiao', 左: 'Zuo', 右: 'You', 前: 'Qian', 后: 'Hou',
  登: 'Deng', 录: 'Lu', 注: 'Zhu', 册: 'Ce', 用: 'Yong', 户: 'Hu', 名: 'Ming', 密: 'Mi', 码: 'Ma', 视: 'Shi',
  图: 'Tu', 本: 'Ben', 按: 'An', 钮: 'Niu', 页: 'Ye', 面: 'Mian', 数: 'Shu', 据: 'Ju', 字: 'Zi',
};

export function chineseToPinyin(chineseWord: string): string {
  let out = '';
  for (const ch of chineseWord) out += PINYIN[ch] ?? ch;
  return out;
}

export function isNumberString(text: string): boolean {
  return /[0-9]+/.test(text);
}

export function isIgnoreAnalysisLine(line: string): boolean {
  const stripped = line.trim();
  if (line.length === 0 || stripped.length === 0) return true;
  if (stripped.startsWith('#') && !stripped.startsWith('#define')) return true;
  if (stripped.startsWith('//')) return true;
  if (stripped.startsWith('/*')) return true;
  return false;
}

export function isXibOrSb(filePath: string): boolean {
  return filePath.endsWith('.xib') || filePath.endsWith('.storyboard');
}

export function isHaveSpecialChar(text: string): boolean {
  const special = '~!@#$%^&*()+-*/<>,.[]\\/';
  for (const ch of special) if (text.includes(ch)) return true;
  return false;
}

const METHOD_STARTS: readonly string[] = ['RSA_', '_ossl_', 'frame', 'mas_', 'mj_', 'sd_', 'yy_', 'bk_', 'allows', 'number', 'cell', 'is', 'data', 'reload', 'min', 'max', 'separator', 'file', 'tableView', 'scrollView', 'application', 'dequeue', 'heightFor', 'cameraView', 'transfor', 'has', 'scrollTo', 'insert', 'animated', 'center', 'bottom', 'indexPath', 'message', 'collectionView', 'newQuadricyc', 'show', 'view', 'shadow', 'selected', 'timeout', 'didReceive', 'tintColor', 'textView', 'textField', 'timeInterval', 'table', 'scroll', 'image', 'shareTo', 'preferred', 'start', 'stop', 'add', 'layoutAttributesFor', 'dispatch_', 'tap', 'keyboard', 'async', 'chatToolBar', 'formatted', 'remove', 'register', 'share', 'send', 'Send', 'delete', 'addRightBarButtonItem', 'onTM', 'onDisconnect', 'stringWith', 'prepareTo', 'downloadTask', 'uploadTask', 'current', 'constraints', 'activityIndicator', 'estimated', 'content', 'size', 'Size', 'nib', 'Unity', 'il2cpp_', 'pthread_', 'inet_', 'onTouch', 'loadTexture', 'bufferevent_', 'evbuffer_', 'event_', 'evutil_', 'evthread_', 'update', 'xml', 'enumerateKeysAnd', 'fetchAlbum', 'delegate', 'CGImage', 'build', 'get', 'set', 'did'];

const METHOD_ENDS: readonly string[] = ['TintColor', 'ForKey', 'Texture', 'ViewController', 'ViewControllerAnimated', 'SpaceToView', 'EqualToView', 'RatioToView', 'OfUID'];

const METHOD_EXACT: Readonly<Set<string>> = new Set(['_free', 'free', '_setFree', 'setFree', '_malloc', 'malloc', '_setMalloc', 'setMalloc', '_setDebugMalloc', 'setDebugMalloc', 'set', 'Set']);

const METHOD_CONTAINS: readonly string[] = [')', '(', '#', ',', '*', ' ', '/'];

export function isPassMethodName(funName: string, isSwift: boolean): boolean {
  if (funName.length <= 4) return true;
  if (FILTER_LIST.includes(funName)) return true;
  if (FILTER_MUST_IGNORE_METHOD_AND_PROPERTY_LIST.includes(funName)) return true;
  if (funName.startsWith('init')) return true;
  if (funName.startsWith('set') && !isSwift && !funName.startsWith('setting')) return true;
  if (funName.startsWith('get') && !isSwift) return true;
  if (funName.startsWith('color') && funName.length <= 11) return true;
  if (METHOD_CONTAINS.some((c) => funName.includes(c))) return true;
  if (pyIsUpper(funName)) return true;
  if (funName.startsWith('save') && funName.endsWith('Value')) return true;
  if (METHOD_STARTS.some((p) => funName.startsWith(p))) return true;
  if (METHOD_ENDS.some((s) => funName.endsWith(s))) return true;
  if (METHOD_EXACT.has(funName)) return true;
  if (isContainChinese(funName)) return true;
  return false;
}

export function isHaveMethodName(line: string): boolean {
  const lineNew = line.replace(/ /g, '');
  const eq = line.indexOf('=');
  const bracket = line.indexOf('(');
  if (bracket > eq && eq !== -1 && bracket !== -1) return false;
  if (!line.includes('(') && !line.includes(')')) return false;
  if (lineNew.startsWith('+(')) return true;
  if (lineNew.startsWith('-(')) return true;
  if (line.startsWith('void ')) return true;
  if (line.startsWith('short ')) return true;
  if (line.startsWith('int ')) return true;
  if (line.startsWith('long ')) return true;
  if (line.startsWith('float ')) return true;
  if (line.startsWith('double ')) return true;
  if (line.startsWith('char ')) return true;
  if (line.startsWith('bool ')) return true;
  if (line.startsWith('BOOL ')) return true;
  return false;
}

export function colonIsInBrackets(line: string): boolean {
  let count = 0;
  for (const ch of line) {
    if (ch === '(') count += 1;
    else if (ch === ')') count -= 1;
    if (ch === ':' && count !== 0) return true;
  }
  return false;
}

export function methodNameListInLine(line: string): string[] {
  const funList: string[] = [];
  if (line.includes('^') && !line.includes(':')) {
    funList.push(line.split(')').at(-1)!.replace(/;/g, '').replace(/ /g, '').replace(/\n/g, ''));
    return funList;
  }
  if (line.startsWith('void ')) {
    funList.push(line.slice(line.indexOf('void ') + 5, line.indexOf('(')).replace(/ /g, '').replace(/\n/g, ''));
    return funList;
  }
  if (line.startsWith('int ')) {
    funList.push(line.slice(line.indexOf('int ') + 4, line.indexOf('(')).replace(/ /g, '').replace(/\n/g, ''));
    return funList;
  }
  line = line.replace(/\+/g, '').replace(/-/g, '').replace(/\+ /g, '').replace(/- /g, '').trim();
  line = line.replace(/ :\(/g, ':(');
  if (line.includes(':') && !colonIsInBrackets(line)) {
    for (let item of line.split(' ')) {
      if (item.includes(':')) {
        item = item.split(':')[0]!;
        item = item.slice(item.indexOf(')') + 1);
        if (item.length > 0) funList.push(item);
      }
    }
    if (funList.length === 1) {
      funList[0] = `${funList[0]}:`;
      return funList;
    }
    return funList;
  }
  const index = line.indexOf(')') + 1;
  const semi = line.indexOf(';');
  let funName = line.slice(index, semi === -1 ? undefined : semi);
  if (funName.length === 0) {
    line = line.slice(0, line.indexOf('('));
    funName = line.split(/\s+/).at(-1)!.trim();
  }
  funList.push(funName);
  return funList;
}

export function createMissMethodName(funName: string, ctx: RenameContext): string {
  const parts = funName.replace(/[A-Z]/g, (m) => `_${m}`).split('_').filter((item) => item.length > 2);
  const lastFunName = parts.length > 0 ? ctx.rng.choice(parts) : pyTitle(randomWordFromLexicon(ctx));
  let miss = randomWordFromLexicon(ctx) + pyCapitalize(randomWordFromLexicon(ctx)) + pyTitle(lastFunName);
  if (funName.startsWith('_')) miss = `_${miss}`;
  return miss;
}

export function getMissMethodNameWithOriginalName(methodName: string, methodPrefix: string | undefined, ctx: RenameContext): string {
  const prefix = methodPrefix ?? '';
  let miss: string;
  if (prefix.length > 0 && prefix.endsWith('#')) miss = `${prefix.split('#')[0]!}${methodName}`;
  else if (ctx.options.algorithmType === 0) miss = createMissMethodName(methodName, ctx);
  else if (ctx.options.algorithmType === 1) miss = randomWordByEnchant(methodName, ctx);
  else if (ctx.options.algorithmType === 3) miss = randomStringNoNumber(methodName.length * 2, ctx);
  else miss = createMissMethodName(methodName, ctx);
  if (prefix.length > 0) miss = prefix.endsWith('_') ? `${prefix}${miss}` : `${prefix}${upperFirst(miss)}`;
  const suffix = ctx.options.methodSuffix ?? '';
  if (suffix.length > 0) miss = `${miss}${suffix}`;
  return miss;
}

export function getMissMethodNameTuple(line: string, methodPrefix: string | undefined, ctx: RenameContext): [string, string] | null {
  const lineNew = line.replace(/\n/g, '').replace(/: \(/g, ':(').replace(/\*\) /g, '*)').trimStart();
  if (!isHaveMethodName(lineNew)) return null;
  const funList = methodNameListInLine(lineNew);
  if (funList.length === 0) return null;
  let funName = funList[0]!.trim();
  if (funName.includes(':')) funName = funName.split(':')[0]!.trim();
  if (isPassMethodName(funName, false)) return null;
  const cached = ctx.methodMap.get(funName);
  if (cached !== undefined) return [funName, cached];
  const repName = getMissMethodNameWithOriginalName(funName, methodPrefix, ctx).replace(/\s+/g, '');
  ctx.methodMap.set(funName, repName);
  return [funName, repName];
}

export function replaceMethodNameInLine(line: string, funName: string, missFunName: string, isXib: boolean): string {
  const markCode2 = '{Z-F-J}';
  const markCode3 = "$Z-F-J$";
  if (line.includes(`*${funName} `)) line = line.replaceAll(`*${funName} `, `*${missFunName} `);
  if (line.includes(`"${funName}"`)) line = line.replaceAll(`"${funName}"`, markCode2);
  if (line.includes(`"${funName}.h"`)) line = line.replaceAll(`"${funName}.h"`, markCode3);

  const c1 = "$MISSFUNCNAME=1$";
  const r1 = `${funName}://`;
  if (line.includes(r1)) line = line.replaceAll(r1, c1);
  const c2 = "$MISSFUNCNAME=2$";
  const r2 = `${funName}/`;
  if (line.includes(r2)) line = line.replaceAll(r2, c2);
  const c3 = "$MISSFUNCNAME=3$";
  const r3 = `/${funName}`;
  if (line.includes(r3)) line = line.replaceAll(r3, c3);
  const c4 = "$MISSFUNCNAME=4$";
  const r4 = `<${funName}>`;
  if (line.includes(r4) && isXib) line = line.replaceAll(r4, c4);

  let result = line.replace(/\b\w+\b/g, (token) => (token === funName ? missFunName : token));
  if (line.includes(`_${funName}`)) result = result.replace(/\b\w+\b/g, (token) => (token === `_${funName}` ? `_${missFunName}` : token));
  if (result.includes(markCode2)) result = result.replaceAll(markCode2, `"${funName}"`);
  if (result.includes(markCode3)) result = result.replaceAll(markCode3, `"${funName}.h"`);
  if (result.includes(c1)) result = result.replaceAll(c1, r1);
  if (result.includes(c2)) result = result.replaceAll(c2, r2);
  if (result.includes(c3)) result = result.replaceAll(c3, r3);
  if (result.includes(c4)) result = result.replaceAll(c4, r4);
  return result;
}

const KEY_WORD_PASS: Readonly<Set<string>> = new Set(['manager', 'model', 'view', 'cell', 'controller', 'root', 'event', 'header', 'is', 'set', 'base', 'with', 'index', 'table', 'api', 'string', 'data', 'error', 'block', 'button', 'time', 'array', 'dictionary', 'key', 'color', 'mutable', 'date', 'picker', 'image', 'integer', 'int', 'collection', 'title', 'label']);

const ARABIC_NUMERALS_MAP: Readonly<Record<string, string>> = { '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '0': 'zero' };

function judgeTitleIsCapitalize(word: string, list: string[]): void {
  if (list.length === 0) return;
  const first = list[0]!;
  list[0] = /[a-z]/.test(word[0] ?? '') ? first.toLowerCase() : pyCapitalize(first);
}

export function randomWordByEnchant(word: string, ctx: RenameContext): string {
  let w = word.includes('-') ? word.replace(/-/g, '_') : word;
  let newWord = '';
  for (let i = 0; i < w.length; i += 1) {
    const ch = w[i]!;
    if (ch >= '0' && ch <= '9') {
      const name = ARABIC_NUMERALS_MAP[ch]!;
      newWord += i === 0 ? name : pyCapitalize(name);
    } else newWord += ch;
  }
  if (isContainChinese(w)) for (const item of w.match(/[一-鿿]+/g) ?? []) newWord = newWord.replace(item, chineseToPinyin(item));
  w = newWord;
  let wordList: string[];
  if (w.includes('_')) {
    const parts = w.split('_');
    const out: string[] = [];
    parts.forEach((part, idx) => {
      out.push(...(part.match(/[a-zA-Z][^A-Z]*/g) ?? []));
      if (idx !== parts.length - 1) out.push('_');
    });
    wordList = out;
  } else wordList = w.match(/[a-zA-Z][^A-Z]*/g) ?? [];
  if (wordList.length === 0) return w;
  const newWordList: string[] = [];
  for (const item of wordList) {
    if (item === '_') { newWordList.push(item); continue; }
    if (KEY_WORD_PASS.has(item.toLowerCase()) || /[0-9]/.test(item)) { newWordList.push(item); continue; }
    const randomWord = randomWordFromLexicon(ctx);
    newWordList.push(pyIsTitle(item) ? pyCapitalize(randomWord) : randomWord.toLowerCase());
  }
  judgeTitleIsCapitalize(w, newWordList);
  let returnWord = newWordList.join('');
  if (w === returnWord) {
    const idx = ctx.rng.randInt(0, newWordList.length - 1);
    if (idx === 0) {
      newWordList[0] = pyTitle(newWordList[0]!);
      newWordList.splice(idx, 0, randomWordFromLexicon(ctx));
    } else newWordList.splice(idx, 0, pyTitle(randomWordFromLexicon(ctx)));
    judgeTitleIsCapitalize(w, newWordList);
    returnWord = newWordList.join('');
  }
  if (returnWord.length <= 3) returnWord += pyTitle(randomWordFromLexicon(ctx));
  if (w.endsWith('_')) return `${returnWord}_`;
  return returnWord;
}

const PROPERTY_STARTS: readonly string[] = ['CG', 'preferred', 'UI', 'NS', 'AV', 'CF', 'HTTP', 'mas_', 'mj_', 'sd_', 'yy_', 'allows', 'start', 'stop', 'add', 'layoutAttributesFor', 'number', 'cell', 'data', 'init', 'weak', 'reload', 'min', 'max', 'separator', 'file', 'tableView', 'scrollView', 'set', 'get', 'application', 'dequeue', 'heightFor', 'cameraView', 'transfor', 'has', 'scrollTo', 'insert', 'animated', 'center', 'bottom', 'indexPath', 'message', 'collectionView', 'show', 'view', 'shadow', 'selected', 'timeout', 'didReceive', 'tintColor', 'timeInterval', 'textView', 'textField', 'table', 'scroll', 'image', 'kCGImage', 'update', '_t', '_value', 'tv_', 'GL', 'offset', 'bool', 'asset', 'ritl_', 'AFNetworking', 'SDWebImage', 'task', 'build', 'get', 'set', 'did', 'WX', 'GIF_', 'Audio', 'DDLog', 'shareTo', 'dispatch_', 'tap', 'keyboard', 'async', 'chatToolBar', 'formatted', 'remove', 'register', 'share', 'send', 'delete', 'addRightBarButtonItem', 'onTM', 'onDisconnect', 'stringWith', 'prepareTo', 'downloadTask', 'uploadTask', 'current', 'constraints', 'activityIndicator', 'estimated', 'content', 'size', 'Size', 'nib', 'markedText', 'lua_get'];

const PROPERTY_ENDS: readonly string[] = ['TintColor', 'ForKey', '_func', 'ViewController', 'ViewControllerAnimated', 'SpaceToView', 'EqualToView', 'RatioToView', 'OfUID', 'StatusBarStyle', 'StatusBarHidden'];

const PROPERTY_EXACT: Readonly<Set<string>> = new Set(['release', 'return', 'ignored', '_nullable', 'int', 'str', 'the', 'cmd', 'void', 'val', 'field', 'token', 'token_', '_token', 'SEL', 'sel']);

const PROPERTY_CONTAINS: readonly string[] = ['Delegate', 'delegate', ' ', ':', ']', '(', ')'];

export function isPassPropertyName(propertyName: string, propertyEndsWithNum = false): boolean {
  if (propertyName.length === 0 || propertyName.length <= 3) return true;
  if (FILTER_LIST.includes(propertyName)) return true;
  if (FILTER_MUST_IGNORE_METHOD_AND_PROPERTY_LIST.includes(propertyName)) return true;
  if (isNumberString(propertyName) && propertyEndsWithNum) return true;
  if (PROPERTY_EXACT.has(propertyName)) return true;
  if (propertyName.startsWith('AL') && pyIsTitle(propertyName[0]!) && pyIsTitle(propertyName[1]!)) return true;
  if (propertyName.startsWith('save') && propertyName.endsWith('Value')) return true;
  if (propertyName.startsWith('bt') && !pyIsTitle(propertyName[2] ?? '')) return true;
  if (propertyName.startsWith('ai_') && !pyIsTitle(propertyName[3] ?? '')) return true;
  if (pyIsUpper(propertyName)) return true;
  if (pyIsDigit(propertyName)) return true;
  if (PROPERTY_STARTS.some((p) => propertyName.startsWith(p))) return true;
  if (PROPERTY_ENDS.some((s) => propertyName.endsWith(s))) return true;
  if (PROPERTY_CONTAINS.some((c) => propertyName.includes(c))) return true;
  return false;
}

const STRING_PUNCTUATION = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^`{|}~");

export function getSetProName(propertyName: string): string {
  return `set${propertyName.slice(0, 1).toUpperCase()}${propertyName.slice(1)}`;
}

export function createMissPropertyNameWithOriginalPropertyName(propertyName: string, ctx: RenameContext, isAddWord = false): string {
  const parts = propertyName.replace(/[A-Z]/g, (m) => `_${m}`).split('_').filter((item) => item.length > 2);
  const lastPropertyName = parts.length > 0 ? parts.at(-1)! : pyTitle(randomWordFromLexicon(ctx));
  let miss: string;
  if (parts.length > 0) miss = randomWordFromLexicon(ctx) + pyTitle(lastPropertyName);
  else if (propertyName.length <= 5) miss = randomWordFromLexicon(ctx) + pyCapitalize(propertyName);
  else miss = randomWordFromLexicon(ctx) + pyCapitalize(propertyName.slice(0, Math.floor(propertyName.length / 2)));
  if (isAddWord) miss = randomWordFromLexicon(ctx) + miss;
  return miss;
}

export function getMissPropertyNameAndAddTemporaryList(propertyName: string, ctx: RenameContext): string | null {
  let miss: string;
  if (ctx.options.algorithmType === 3) miss = randomStringNoNumber(propertyName.length * 2, ctx);
  else {
    miss = createMissPropertyNameWithOriginalPropertyName(propertyName, ctx);
    if (miss === 'Array') miss = randomWordFromLexicon(ctx) + miss;
  }
  if (propertyName.startsWith('_')) miss = `_${miss}`;
  if (ctx.temporaryPropertyNames.has(miss)) return null;
  ctx.temporaryPropertyNames.add(miss);
  return miss;
}

export function getOcMissPropertyNameTub(propertyName: string, propertyPrefix: string | undefined, ctx: RenameContext): string {
  const prefix = propertyPrefix ?? '';
  if (prefix.length > 0 && prefix.endsWith('#')) return `${prefix.split('#')[0]!}${propertyName}`;
  const miss = ctx.options.algorithmType === 1
    ? randomWordByEnchant(propertyName, ctx)
    : getMissPropertyNameAndAddTemporaryList(propertyName, ctx) ?? randomWordByEnchant(propertyName, ctx);
  if (prefix.length > 0) return prefix.endsWith('_') ? `${prefix}${miss}` : `${prefix}${upperFirst(miss)}`;
  return miss;
}

export function getSwiftMissPropertyNameTub(propertyName: string, propertyPrefix: string | undefined, ctx: RenameContext): string {
  const prefix = propertyPrefix ?? '';
  let miss = randomWordFromLexicon(ctx);
  if (prefix.length > 0 && prefix.endsWith('#')) miss = `${prefix.split('#')[0]!}${propertyName}`;
  else if (prefix.length > 0) {
    const base = ctx.options.algorithmType === 1
      ? randomWordByEnchant(propertyName, ctx)
      : getMissPropertyNameAndAddTemporaryList(propertyName, ctx) ?? randomWordByEnchant(propertyName, ctx);
    miss = prefix.endsWith('_') ? `${prefix}${base}` : `${prefix}${upperFirst(base)}`;
  } else {
    miss = ctx.options.algorithmType === 1
      ? randomWordByEnchant(propertyName, ctx)
      : getMissPropertyNameAndAddTemporaryList(propertyName, ctx) ?? randomWordByEnchant(propertyName, ctx);
  }
  if (propertyName.startsWith('_')) miss = `_${miss}`;
  return miss;
}

function resolvePropertyMissName(propertyName: string, propertyPrefix: string | undefined, ctx: RenameContext, isSwift: boolean): string | null {
  const cached = ctx.propertyMap.get(propertyName);
  if (cached !== undefined) return cached;
  let miss = isSwift ? getSwiftMissPropertyNameTub(propertyName, propertyPrefix, ctx) : getOcMissPropertyNameTub(propertyName, propertyPrefix, ctx);
  if (new Set(ctx.propertyMap.values()).has(miss)) miss += pyTitle(randomWordFromLexicon(ctx));
  if (FILTER_LIST.includes(miss)) miss += pyTitle(randomWordFromLexicon(ctx));
  if (FILTER_MUST_IGNORE_METHOD_AND_PROPERTY_LIST.includes(propertyName)) miss += pyTitle(randomWordFromLexicon(ctx));
  ctx.propertyMap.set(propertyName, miss);
  return miss;
}

export function ocPropertyNameTup(line: string, propertyPrefix: string | undefined, ctx: RenameContext): [string, string] | null {
  if (isIgnoreAnalysisLine(line)) return null;
  let work = line;
  if (work.includes('*')) work = work.replace(/\*/g, ' * ');
  if (work.includes('\t')) work = work.replace(/\t/g, ' ');
  if (work.includes('\n')) work = work.replace(/\n/g, ' ');
  let propertyName: string | null = null;
  if (work.includes('(^')) {
    const compact = work.split(/\s+/).join('');
    propertyName = compact.slice(compact.indexOf('(^') + 2, compact.indexOf(')('));
  } else {
    let lineNew = work.split(';')[0]!;
    lineNew = lineNew.replace(/<.*?>/g, ' ').replace(/@property /g, '');
    const lineListNew = lineNew.split(' ').reverse().filter((x) => x.length > 0);
    const starIndex = lineListNew.indexOf('*');
    if (starIndex !== -1) propertyName = lineListNew[starIndex - 1] ?? null;
    else {
      for (const item of lineListNew) {
        if (!pyIsUpper(item) && ![...item].some((ch) => STRING_PUNCTUATION.has(ch))) { propertyName = item; break; }
      }
    }
  }
  if (propertyName == null) return null;
  propertyName = propertyName.split(' ').join('');
  if (propertyName.startsWith('*')) propertyName = propertyName.slice(1);
  if (propertyName.startsWith('_')) propertyName = propertyName.slice(1);
  if (propertyName.endsWith(';') || propertyName.endsWith(',')) propertyName = propertyName.slice(0, -1);
  if (isPassPropertyName(propertyName)) return null;
  const miss = resolvePropertyMissName(propertyName, propertyPrefix, ctx, false);
  return miss === null ? null : [propertyName, miss];
}

export function ocConstantNameTup(line: string, propertyPrefix: string | undefined, ctx: RenameContext): [string, string] | null {
  if (isIgnoreAnalysisLine(line)) return null;
  const work = line.replace(/\*/g, ' ').replace(/\n/g, '');
  let propertyName: string | null = null;
  for (const item of work.split(' ')) if (item.includes(';')) { propertyName = item.split(';')[0]!; break; }
  if (propertyName == null) return null;
  propertyName = propertyName.split(' ').join('');
  if (propertyName.startsWith('*')) propertyName = propertyName.slice(1);
  if (propertyName.startsWith('_')) propertyName = propertyName.slice(1);
  if (propertyName.endsWith(';') || propertyName.endsWith(',')) propertyName = propertyName.slice(0, -1);
  if (isPassPropertyName(propertyName)) return null;
  const miss = resolvePropertyMissName(propertyName, propertyPrefix, ctx, false);
  return miss === null ? null : [propertyName, miss];
}

export function swiftCppPropertyNameTup(line: string, propertyPrefix: string | undefined, _isCCFile: boolean, ctx: RenameContext): [string, string] | null {
  if (isIgnoreAnalysisLine(line)) return null;
  let lineNew = line.replace(/\[.*?\]/g, ' ');
  if (lineNew.includes('//')) lineNew = lineNew.slice(0, lineNew.indexOf('//'));
  lineNew = lineNew.replace(/\/.*?\*\//g, '');
  lineNew = lineNew.replace(/;/g, ' ').replace(/\t/g, ' ').replace(/\n/g, ' ').trim();
  if (lineNew.includes('::')) return null;
  if (lineNew.length === 0) return null;
  if (lineNew.startsWith('@NSManaged ')) return null;
  let propertyName: string | null = null;
  if (lineNew.includes('var ') && lineNew.includes(':') && !lineNew.includes('=')) propertyName = lineNew.slice(lineNew.indexOf('var ') + 4, lineNew.indexOf(':'));
  else if (lineNew.includes('var ') && lineNew.includes('=')) propertyName = lineNew.slice(lineNew.indexOf('var ') + 4, lineNew.indexOf('='));
  else if (lineNew.includes('let ') && lineNew.includes(':') && !lineNew.includes('=')) propertyName = lineNew.slice(lineNew.indexOf('let ') + 4, lineNew.indexOf(':'));
  else if (lineNew.includes('let ') && lineNew.includes('=')) propertyName = lineNew.slice(lineNew.indexOf('let ') + 4, lineNew.indexOf('='));
  if (propertyName == null) {
    const lineNoWrap = line.trim();
    if (line.includes(' *') && line.includes('(') && line.includes(')')) propertyName = line.slice(line.indexOf('*') + 1, line.indexOf('(')).split(' ')[0] ?? null;
    else if (line.includes(' *') && (lineNoWrap.endsWith(';') || lineNoWrap.endsWith(','))) {
      for (const item of lineNew.split(' ')) if (item.includes('*')) { propertyName = item.replace(/\*/g, ''); break; }
    } else {
      const basic = ['short', 'int', 'long', 'float', 'double', 'char', 'bool', 'int64_t', 'const', 'BOOL'];
      const lineListNew = lineNew.split(' ');
      const intersection = basic.filter((v) => lineListNew.includes(v));
      const eqIndex = lineListNew.includes('=') ? lineListNew.indexOf('=') : -1;
      if (eqIndex !== -1) propertyName = lineListNew[eqIndex - 1] ?? null;
      else if (intersection.length === 1) {
        const start = lineListNew.indexOf(intersection[0]!) + 1;
        for (let i = start; i < lineListNew.length; i += 1) {
          propertyName = lineListNew[i]!;
          if (propertyName === 'unichar') propertyName = '';
          if (propertyName.length > 0) break;
        }
      }
    }
  }
  if (propertyName == null) return null;
  propertyName = propertyName.trim();
  propertyName = propertyName.split(' ').join('');
  if (propertyName.includes(':')) propertyName = propertyName.split(':')[0]!;
  if (propertyName.startsWith('*')) propertyName = propertyName.slice(1);
  if (propertyName.startsWith('_')) propertyName = propertyName.slice(1);
  if (propertyName.endsWith(';') || propertyName.endsWith(',')) propertyName = propertyName.slice(0, -1);
  if (isPassPropertyName(propertyName)) return null;
  if ([...propertyName].some((ch) => STRING_PUNCTUATION.has(ch))) return null;
  const miss = resolvePropertyMissName(propertyName, propertyPrefix, ctx, true);
  return miss === null ? null : [propertyName, miss];
}

function maskQuotedStrings(line: string): { line: string; restore: (s: string) => string } {
  const store: string[] = [];
  let idx = 0;
  line = line.replace(/"([^"]*)"/g, (_full, content: string) => {
    const token = `\u0000Q${idx++}\u0000`;
    store.push(content);
    return `"${token}"`;
  });
  return {
    line,
    restore(s) { return s.replace(/"\u0000Q(\d+)\u0000"/g, (_f, n: string) => `"${store[Number(n)]}"`); },
  };
}

export function replacePropertyNameInLine(line: string, propertyName: string, missPropertyName: string, isSwift: boolean, isXib: boolean, isWithinQuotationMarks: boolean): string {
  if (isIgnoreAnalysisLine(line)) return line;
  const masked = maskQuotedStrings(line);
  line = masked.line;
  if (isSwift && line.includes(`(${propertyName})`)) line = line.replaceAll(`(${propertyName})`, `(${missPropertyName})`);
  const setProp = `set${propertyName.slice(0, 1).toUpperCase()}${propertyName.slice(1)}`;
  const missSetProp = `set${missPropertyName.slice(0, 1).toUpperCase()}${missPropertyName.slice(1)}`;
  if (line.includes(setProp)) line = line.replaceAll(setProp, missSetProp);
  line = line.replace(/\b\w+\b/g, (token) => {
    if (token === propertyName) return missPropertyName;
    if (token === `_${propertyName}`) return `_${missPropertyName}`;
    if (token === `${propertyName}Set`) return `${missPropertyName}Set`;
    return token;
  });
  return masked.restore(line);
}

const OBJECT_NAME_PASS_LIST: readonly string[] = ['Config', 'text', 'lock', 'debug', 'Base', 'Version', 'main', 'Codable', 'version', 'thread', 'cocos2d', 'system', 'titleView', 'RootViewController', 'TabBarController', 'Decodable', 'Request', 'WebCache', 'YYAdd'];

export function isPassObjectName(objectName: string, ctx: RenameContext): boolean {
  if (FILTER_CLASS_NAME_LIST.includes(objectName)) return true;
  if (objectName.includes('AppDelegate')) return true;
  if (objectName.length <= 4) return true;
  if (objectName.startsWith('MEIQIA_')) return true;
  if (objectName.startsWith('UMCSDK')) return true;
  if (objectName.startsWith('OSS')) return true;
  if (objectName.startsWith('GTT')) return true;
  if (objectName.startsWith('_')) return true;
  if (objectName.startsWith('x86')) return true;
  if (objectName.startsWith('x64')) return true;
  if (objectName.startsWith('win32_')) return true;
  if (objectName.startsWith('UI')) return true;
  if (objectName.startsWith('NS')) return true;
  if (objectName.startsWith('Agora')) return true;
  if (objectName.startsWith('MJRefresh')) return true;
  if (objectName.includes('-')) return true;
  if (OBJECT_NAME_PASS_LIST.includes(objectName)) return true;
  if (ctx.projectNames.includes(objectName)) return true;
  if (ctx.classMap.has(objectName)) return true;
  if (isContainChinese(objectName)) return true;
  return false;
}

export function getMissObjName(oldObjName: string, ctx: RenameContext): string {
  if (oldObjName.includes('+')) oldObjName = oldObjName.split('+').at(-1)!;
  let parts = oldObjName.replace(/[A-Z]/g, (m) => `_${m}`).split('_').filter((item) => item.length > 2);
  if (parts.length > 2) parts = parts.slice(-2);
  if (parts.length <= 2) parts.unshift(pyTitle(randomWordFromLexicon(ctx)));
  parts.unshift(pyTitle(randomWordFromLexicon(ctx)));
  return parts.join('');
}

export function getMissClassName(className: string, classPrefix: string | undefined, ctx: RenameContext): string {
  if (className.length === 0) return className;
  const prefix = classPrefix ?? '';
  let miss: string;
  if (prefix.length > 0 && prefix.endsWith('#')) miss = `${prefix.split('#')[0]!}${className.includes('+') ? className.split('+').at(-1)! : className}`;
  else if (ctx.options.algorithmType === 0) miss = getMissObjName(className, ctx).replace(/new/g, 'OBF');
  else if (ctx.options.algorithmType === 1) miss = randomWordByEnchant(className, ctx);
  else if (ctx.options.algorithmType === 3) miss = randomStringNoNumber(className.length, ctx);
  else miss = `${prefix}${getMissObjName(className, ctx).replace(/new/g, 'OBF')}`;
  if (miss.length > 0) miss = /[a-z]/.test(className[0]!) ? miss[0]!.toLowerCase() + miss.slice(1) : upperFirst(miss);
  if (prefix.length > 0 && prefix.endsWith('_')) miss = `${prefix}${miss}`;
  else if (prefix.length > 0 && !prefix.endsWith('#')) miss = `${prefix}${upperFirst(miss)}`;
  if (ctx.allMissClassNames.has(miss)) return `${miss}${pyTitle(randomWordFromLexicon(ctx))}`;
  ctx.allMissClassNames.add(miss);
  return miss;
}

export function replaceObjNameByReInLine(line: string, objectName: string, missObjectName: string): string {
  let result = line.replace(/\b\w+\b/g, (token) => (token === objectName ? missObjectName : token));
  const sharedName = `shared${objectName}`;
  if (result.includes(sharedName)) result = result.replace(/\b\w+\b/g, (token) => (token === sharedName ? `shared${missObjectName}` : token));
  if (result.includes(`"${objectName}.`)) result = result.replaceAll(`"${objectName}.`, `"${missObjectName}.`);
  return result;
}

function collectMethodPrefixTuple(line: string, oldPrefix: string, newPrefix: string, ctx: RenameContext): [string, string] | null {
  const lineNew = line.replace(/\n/g, '').replace(/: \(/g, ':(').replace(/\*\) /g, '*)').trimStart();
  if (!isHaveMethodName(lineNew)) return null;
  const funList = methodNameListInLine(lineNew);
  if (funList.length === 0) return null;
  let methodName = funList[0]!.trim();
  if (methodName.includes(':')) methodName = methodName.split(':')[0]!.trim();
  if (!methodName.startsWith(oldPrefix)) return null;
  if (isPassMethodName(methodName, false) || methodName.startsWith('newQuadricyc')) return null;
  const replace = `${newPrefix}${methodName.slice(oldPrefix.length)}`;
  ctx.methodMap.set(methodName, replace);
  return [methodName, replace];
}

export function propertyNameReplaceTuple(line: string, oldPrefix: string, newPrefix: string): [string, string] | null {
  const trimmed = line.replace(/\n/g, '').trim();
  const withoutSemi = trimmed.slice(0, trimmed.indexOf(';') === -1 ? undefined : trimmed.indexOf(';'));
  const work = withoutSemi.replace(/\* /g, '*');
  let propertyName: string | null = null;
  const compact = work.split(/\s+/).join('');
  if (compact.includes('(^')) propertyName = compact.slice(compact.indexOf('(^') + 2, compact.indexOf(')('));
  else {
    const tail = work.split(')').at(-1)!.trim();
    let list: string[];
    if (tail.includes(' ')) list = tail.split(' ');
    else if (!tail.includes(' ') && work.includes('*')) list = tail.split('*');
    else list = [];
    if (list.length < 2) return null;
    const starItem = list.find((item) => item.includes('*'));
    propertyName = starItem == null ? list[1]!.replace(/\*/g, '') : starItem.slice(starItem.indexOf('*') + 1);
  }
  if (propertyName.includes('>')) propertyName = propertyName.slice(propertyName.indexOf('>') + 1);
  propertyName = propertyName.replace(/\*/g, '');
  if (!propertyName.startsWith(oldPrefix)) return null;
  if (isNumberString(propertyName)) return null;
  if (isPassPropertyName(propertyName)) return null;
  if ([...propertyName].some((ch) => STRING_PUNCTUATION.has(ch))) return null;
  return [propertyName, `${newPrefix}${propertyName.slice(oldPrefix.length)}`];
}

function replaceClassPrefixInLine(line: string, objectName: string, replaceName: string): string {
  if ((line.includes('initWithRootViewController') || line.includes('popToRootViewControllerAnimated')) && objectName === 'RootViewController') return line;
  if (line.includes('navigationItem.titleView') && objectName === 'titleView') return line;
  if (line.includes('UITabBarController') && objectName === 'TabBarController') return line;
  if (line.startsWith('#import') || line.startsWith('#include')) {
    let out = line;
    out = out.replaceAll(`"${objectName}.`, `"${replaceName}.`);
    out = out.replaceAll(`/${objectName}.`, `/${replaceName}.`);
    return out;
  }
  if (line.includes('import') && !line.includes('#import')) return line.replaceAll(` ${objectName}.`, ` ${replaceName}.`);
  return replaceObjNameByReInLine(line, objectName, replaceName);
}

const OC_VIEW_LIST: readonly string[] = ['UIView', 'UILabel', 'UIButton', 'UISegmentedControl', 'UITextField', 'UISlider', 'UISwitch', 'UIProgressView', 'UITableView', 'UITableViewCell', 'UIImageView', 'UICollectionView', 'UICollectionViewCell', 'UITextView', 'UIScrollView', 'UIPickerView'];

export function getSpaceCount(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === ' ') count += 1;
    else break;
  }
  return count;
}

export function getClassProNameTub(line: string, isSwift: boolean): [string, string] | null {
  const newLine = line.replace(/\s+/g, '');
  let ret: [string, string] | null = null;
  for (const className of OC_VIEW_LIST) {
    if (!isSwift) {
      if (line.includes(`[${className} `) && line.includes('=')) ret = [line.slice(line.indexOf('*') + 1, line.indexOf('=')).trim(), className];
    } else if (newLine.includes(`${className}(`) && line.includes('=')) {
      let proName: string;
      if (line.includes('let ')) proName = line.slice(line.indexOf('let ') + 4, line.indexOf('='));
      else if (line.includes('var ')) proName = line.slice(line.indexOf('var ') + 4, line.indexOf('='));
      else proName = line.slice(line.indexOf(' ') + 1, line.indexOf('='));
      if (proName.includes(':')) proName = proName.split(':')[0]!;
      ret = [proName.trim(), className];
    }
  }
  if (line.includes('//') && ret != null && line.indexOf('//') < line.indexOf(ret[0])) ret = null;
  return ret;
}

function round2(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

export function ocRandomColor(alpha: number, ctx: RenameContext): string {
  return `[UIColor colorWithRed:${round2(ctx.rng.next())} green:${round2(ctx.rng.next())} blue:${round2(ctx.rng.next())} alpha:${alpha}]`;
}

export function swiftRandomColor(alpha: number, ctx: RenameContext): string {
  return `UIColor.init(red: ${round2(ctx.rng.next())}, green: ${round2(ctx.rng.next())}, blue: ${round2(ctx.rng.next())}, alpha: ${alpha})`;
}

function swiftSysColor(line: string): string | null {
  const colors = ['black', 'darkGray', 'lightGray', 'white', 'gray', 'red', 'green', 'blue', 'cyan', 'yellow', 'magenta', 'orange', 'purple', 'brown', 'clear', 'groupTableViewBackground'];
  for (const color of colors) if (line.includes(`UIColor.${color}`)) return `UIColor.${color}`;
  return null;
}

function getSwiftColorCodeInLine(line: string): string | null {
  const sys = swiftSysColor(line);
  if (sys != null) return sys;
  const start = line.indexOf('UIColor.');
  if (start === -1) return null;
  let depth = 0;
  let lastClose = -1;
  for (let i = start; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) { lastClose = i; break; }
    }
  }
  if (lastClose === -1) return null;
  return line.slice(start, lastClose + 1);
}

export function ocColorReplaceLine(line: string, alpha: number, ctx: RenameContext): string {
  const start = line.indexOf('[UIColor ');
  if (start === -1) return line;
  const end = line.indexOf(']', start);
  if (end === -1) return line;
  return line.replace(line.slice(start, end + 1), ocRandomColor(alpha, ctx));
}

export function changeViewBackgroundColor(line: string, isSwift: boolean, magic: ObjcMagicColorOptions, ctx: RenameContext): string {
  const isRepBgColor = magic.replaceColor?.[0] ?? -1;
  const isRepTextColor = magic.replaceColor?.[1] ?? -1;
  const isRepClearColor = magic.replaceColor?.[2] ?? -1;
  const isAddBgColor = magic.addColor ?? -1;
  const isAddTextColor = magic.textColor ?? -1;
  const bgAlpha = magic.alpha?.[0] ?? 1;
  const textAlpha = magic.alpha?.[1] ?? 1;
  const otherAlpha = 1;

  const proNameTub = getClassProNameTub(line, isSwift);
  if (proNameTub != null) {
    const spaceCount = getSpaceCount(line);
    if (isSwift) {
      if (spaceCount > 4) {
        if (isAddBgColor !== -1) line += `${' '.repeat(spaceCount)}${proNameTub[0]}.backgroundColor = ${swiftRandomColor(bgAlpha, ctx)}\n`;
        if (isAddTextColor !== -1) {
          if (proNameTub[1] === 'UILabel' || proNameTub[1] === 'UITextField') {
            line += `${' '.repeat(spaceCount)}${proNameTub[0]}.textColor = ${swiftRandomColor(textAlpha, ctx)}\n`;
            return line;
          }
          if (proNameTub[1] === 'UIButton') line += `${' '.repeat(spaceCount)}${proNameTub[0]}.setTitleColor(${swiftRandomColor(textAlpha, ctx)}, for: .normal)\n`;
        }
      }
      return line;
    }
    if (isAddBgColor !== -1) line += `${' '.repeat(spaceCount)}${proNameTub[0]}.backgroundColor = ${ocRandomColor(bgAlpha, ctx)};\n`;
    if (isAddTextColor !== -1) {
      if (proNameTub[1] === 'UILabel' || proNameTub[1] === 'UITextField') {
        line += `${' '.repeat(spaceCount)}${proNameTub[0]}.textColor = ${ocRandomColor(textAlpha, ctx)};\n`;
        return line;
      }
      if (proNameTub[1] === 'UIButton') line += `${' '.repeat(spaceCount)}[${proNameTub[0]} setTitleColor:${ocRandomColor(textAlpha, ctx)} forState:UIControlStateNormal];\n`;
    }
    return line;
  }

  if (isSwift) {
    if ((line.includes('UIColor.init(') || line.includes('UIColor.')) && !line.includes('UIColor.clear')) {
      const oldColorCode = getSwiftColorCodeInLine(line);
      if (line.includes('.backgroundColor') && oldColorCode != null) return isRepBgColor !== -1 ? line.replace(oldColorCode, swiftRandomColor(bgAlpha, ctx)) : line;
      if ((line.includes(' setTitleColor:') || line.includes('.tintColor')) && oldColorCode != null) return isRepTextColor !== -1 ? line.replace(oldColorCode, swiftRandomColor(textAlpha, ctx)) : line;
      return oldColorCode != null ? line.replace(oldColorCode, swiftRandomColor(otherAlpha, ctx)) : line;
    }
    if (line.includes('UIColor.clear') && isRepClearColor !== -1) {
      const oldColorCode = 'UIColor.clear';
      if (line.includes('.backgroundColor')) return isRepBgColor !== -1 ? line.replace(oldColorCode, swiftRandomColor(bgAlpha, ctx)) : line;
      if (line.includes(' setTitleColor:') || line.includes('.tintColor')) return isRepTextColor !== -1 ? line.replace(oldColorCode, swiftRandomColor(textAlpha, ctx)) : line;
      return line.replace(oldColorCode, swiftRandomColor(otherAlpha, ctx));
    }
    return line;
  }

  if (line.includes('[UIColor ')) {
    if (line.includes('.backgroundColor') || line.includes(' setBackgroundColor:')) return isRepBgColor !== -1 ? ocColorReplaceLine(line, bgAlpha, ctx) : line;
    if (line.includes(' setTextColor:') || line.includes(' setTitleColor:') || line.includes('.tintColor') || line.includes(' setTintColor:')) return isRepTextColor !== -1 ? ocColorReplaceLine(line, textAlpha, ctx) : line;
    return ocColorReplaceLine(line, otherAlpha, ctx);
  }
  if ((line.includes('[UIColor clearColor]') || line.includes('UIColor.clearColor')) && isRepClearColor !== -1) {
    const oldColorCode = line.includes('[UIColor clearColor]') ? '[UIColor clearColor]' : 'UIColor.clearColor';
    if (line.includes('.backgroundColor') || line.includes(' setBackgroundColor:')) return isRepBgColor !== -1 ? line.replace(oldColorCode, ocRandomColor(bgAlpha, ctx)) : line;
    if (line.includes(' setTextColor:') || line.includes(' setTitleColor:') || line.includes('.tintColor') || line.includes(' setTintColor:')) return isRepTextColor !== -1 ? line.replace(oldColorCode, ocRandomColor(textAlpha, ctx)) : line;
    return line.replace(oldColorCode, ocRandomColor(otherAlpha, ctx));
  }
  return line;
}

const DEFAULT_EXTENSIONS: readonly string[] = ['m', 'mm', 'cpp', 'h', 'swift', 'pch', 'c', 'cc', 'xib', 'storyboard', 'inl', 'hpp'];

function isSupported(relative: string, options: ObjcSymbolsOptions): boolean {
  const allowed = new Set(options.fileExtensions ?? DEFAULT_EXTENSIONS);
  return allowed.has(extension(relative));
}

function basenameWithoutExtension(relative: string): string {
  const base = relative.slice(relative.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 1 ? base : base.slice(0, dot);
}

function transformLine(ctx: RenameContext, relative: string, line: string): string {
  const isSwift = extension(relative) === 'swift';
  const isXib = isXibOrSb(relative);
  let out = line;
  for (const [from, to] of ctx.methodMap) if (out.includes(from)) out = replaceMethodNameInLine(out, from, to, isXib);
  for (const [from, to] of ctx.propertyMap) if (out.includes(from) || out.includes(getSetProName(from))) out = replacePropertyNameInLine(out, from, to, isSwift, isXib, false);
  for (const [from, to] of ctx.classMap) if (out.includes(from)) out = replaceObjNameByReInLine(out, from, to);
  if (ctx.options.magicColor?.enabled) out = changeViewBackgroundColor(out, isSwift, ctx.options.magicColor, ctx);
  return out;
}

function collectMethodFromLine(ctx: RenameContext, line: string): void {
  getMissMethodNameTuple(line, ctx.options.methodPrefix, ctx);
}

function collectSwiftMethod(ctx: RenameContext, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.includes('func ')) return;
  let funcName = trimmed.slice(trimmed.indexOf('func ') + 5);
  funcName = funcName.slice(0, funcName.indexOf('{') === -1 ? undefined : funcName.indexOf('{'));
  if (funcName.includes('(')) funcName = funcName.slice(0, funcName.indexOf('('));
  funcName = funcName.trim();
  if (isHaveSpecialChar(funcName) || funcName.length <= 3) return;
  if (isPassMethodName(funcName, true)) return;
  if (FILTER_LIST.includes(funcName)) return;
  if (!ctx.methodMap.has(funcName)) {
    const prefix = ctx.options.methodPrefix ?? '';
    let miss: string;
    if (prefix.endsWith('#')) miss = `${prefix.split('#')[0]!}${funcName}`;
    else {
      const suffix = ctx.options.methodSuffix ?? '';
      miss = randomWordFromLexicon(ctx) + pyCapitalize(randomWordFromLexicon(ctx)) + pyCapitalize(randomWordFromLexicon(ctx)) + suffix;
      if (prefix.length > 0) miss = prefix.endsWith('_') ? `${prefix}${miss}` : `${prefix}${pyCapitalize(miss)}`;
    }
    ctx.methodMap.set(funcName, miss.replace(/\s+/g, ''));
  }
}

function collectPropertiesForLine(ctx: RenameContext, relative: string, line: string): void {
  if (isIgnoreAnalysisLine(line)) return;
  const ext = extension(relative);
  if (ext === 'h' || ext === 'm' || ext === 'mm' || ext === 'cpp') {
    if (line.includes('@property')) ocPropertyNameTup(line, ctx.options.propertyPrefix, ctx);
    else if (line.trim().startsWith('@interface') || line.trim().startsWith('@implementation')) ocConstantNameTup(line, ctx.options.propertyPrefix, ctx);
    else swiftCppPropertyNameTup(line, ctx.options.propertyPrefix, ext === 'cpp', ctx);
  } else if (ext === 'swift') {
    swiftCppPropertyNameTup(line, ctx.options.propertyPrefix, false, ctx);
  }
}

export function obfuscateObjcContent(content: string, options: ObjcSymbolsOptions = {}, seed: string): string {
  const ctx = createRenameContext(options, seed);
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.trim().includes('func ')) collectSwiftMethod(ctx, line);
    else collectMethodFromLine(ctx, line);
    collectPropertiesForLine(ctx, 'sample.swift', line);
  }
  return lines.map((line) => transformLine(ctx, 'sample.swift', line)).join('\n');
}

export function renameObjcSymbols(files: WalkEntry[], options: ObjcSymbolsOptions = {}, seed: string): TransformOutcome {
  const ctx = createRenameContext(options, seed);
  const ordered = [...files].sort((a, b) => a.relative.localeCompare(b.relative));
  const classPrefixOpt = options.replaceClassPrefix;
  const methodPrefixOpt = options.replaceMethodPrefix;
  const propertyPrefixOpt = options.replacePropertyPrefix;

  const headers = new Set<string>();
  const impls = new Set<string>();
  for (const entry of ordered) {
    const base = basenameWithoutExtension(entry.relative);
    const ext = extension(entry.relative);
    if (ext === 'h') headers.add(base);
    if (ext === 'm' || ext === 'mm' || ext === 'cpp' || ext === 'hpp' || ext === 'swift') impls.add(base);
  }
  for (const base of [...headers].sort()) {
    if (!impls.has(base) || base.includes('+')) continue;
    if (classPrefixOpt) {
      if (!base.startsWith(classPrefixOpt.from) || base.includes('AppDelegate')) continue;
      ctx.classMap.set(base, `${classPrefixOpt.to}${base.slice(classPrefixOpt.from.length)}`);
      continue;
    }
    if (isPassObjectName(base, ctx)) continue;
    ctx.classMap.set(base, getMissClassName(base, ctx.options.classPrefix, ctx));
  }

  for (const entry of ordered) {
    if (!isSupported(entry.relative, ctx.options)) continue;
    const content = readFileSync(entry.absolute, 'utf8');
    const ext = extension(entry.relative);
    if (methodPrefixOpt) {
      if (ext === 'h') for (const line of content.split('\n')) collectMethodPrefixTuple(line, methodPrefixOpt.from, methodPrefixOpt.to, ctx);
    } else if (ext === 'h') {
      for (const line of content.split('\n')) collectMethodFromLine(ctx, line);
    } else if (ext === 'swift') {
      for (const line of content.split('\n')) collectSwiftMethod(ctx, line);
    }
    if (['h', 'm', 'mm', 'cpp', 'swift'].includes(ext)) {
      for (const line of content.split('\n')) {
        if (propertyPrefixOpt) {
          if (line.includes('@property')) {
            const tuple = propertyNameReplaceTuple(line, propertyPrefixOpt.from, propertyPrefixOpt.to);
            if (tuple) ctx.propertyMap.set(tuple[0], tuple[1]);
          }
        } else {
          collectPropertiesForLine(ctx, entry.relative, line);
        }
      }
    }
  }

  const changedPaths: string[] = [];
  let changed = 0;
  for (const entry of ordered) {
    if (!isSupported(entry.relative, ctx.options)) continue;
    const before = readFileSync(entry.absolute, 'utf8');
    const after = before.split('\n').map((line) => transformLine(ctx, entry.relative, line)).join('\n');
    if (after !== before) {
      if (writeIfChanged(entry, after)) {
        changed += 1;
        changedPaths.push(entry.relative);
      }
    }
  }
  return { changed, changedPaths };
}










