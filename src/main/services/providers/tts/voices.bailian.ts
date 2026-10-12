import type { VoiceGroup } from '../../../../shared/types'

/**
 * 阿里云百炼系统音色静态目录。
 * 来源：百炼官方文档「CosyVoice 音色列表」「Qwen-TTS 音色列表」页解析（2025-10 抓取），按页面分组；
 * cosyvoice-v3.5 / qwen-audio-3.x 官方页未给系统音色目录（voices=[]，手动输入兜底）；
 * 复刻音色不在目录里——它们来自 voice-enrollment 克隆产物。
 */
/** qwen3-tts-flash：官方音色列表（英文名 id） */
export const qwen3TtsFlashVoices: VoiceGroup[] = [
  {
    label: '系统音色',
    voices: [
      { id: 'Cherry', name: '芊悦', desc: '阳光积极、亲切自然小姐姐（女性）' },
      { id: 'Serena', name: '苏瑶', desc: '温柔小姐姐（女性）' },
      { id: 'Ethan', name: '晨煦', desc: '标准普通话，带部分北方口音。阳光、温暖、活力、朝气（男性）' },
      { id: 'Chelsie', name: '千雪', desc: '二次元虚拟女友（女性）' },
      { id: 'Momo', name: '茉兔', desc: '撒娇搞怪，逗你开心（女性）' },
      { id: 'Vivian', name: '十三', desc: '拽拽的、可爱的小暴躁（女性）' },
      { id: 'Moon', name: '月白', desc: '率性帅气的月白（男性）' },
      { id: 'Maia', name: '四月', desc: '知性与温柔的碰撞（女性）' },
      { id: 'Kai', name: '凯', desc: '耳朵的一场' },
      { id: 'Nofish', name: '不吃鱼', desc: '不会翘舌音的设计师（男性）' },
      { id: 'Bella', name: '萌宝', desc: '喝酒不打醉拳的小萝莉（女性）' },
      { id: 'Jennifer', name: '詹妮弗', desc: '品牌级、电影质感般美语女声（女性）' },
      { id: 'Ryan', name: '甜茶', desc: '节奏拉满，戏感炸裂，真实与张力共舞（男性）' },
      { id: 'Katerina', name: '卡捷琳娜', desc: '御姐音色，韵律回味十足（女性）' },
      { id: 'Aiden', name: '艾登', desc: '精通厨艺的美语大男孩（男性）' },
      { id: 'Eldric Sage', name: '沧明子', desc: '沉稳睿智的老者，沧桑如松却心明如镜（男性）' },
      { id: 'Mia', name: '乖小妹', desc: '温顺如春水，乖巧如初雪（女性）' },
      { id: 'Mochi', name: '沙小弥', desc: '聪明伶俐的小大人，童真未泯却早慧如禅（男性）' },
      { id: 'Bellona', name: '燕铮莺', desc: '声音洪亮，吐字清晰，人物鲜活，听得人热血沸腾；金戈铁马入梦来，字正腔圆间尽显千面人声的江湖（女性）' },
      { id: 'Vincent', name: '田叔', desc: '一口独特的沙哑烟嗓，一开口便道尽了千军万马与江湖豪情（男性）' },
      { id: 'Bunny', name: '萌小姬', desc: '“萌属性”爆棚的小萝莉（女性）' },
      { id: 'Neil', name: '阿闻', desc: '平直的基线语调，字正腔圆的咬字发音，这就是最专业的新闻主持人（男性）' },
      { id: 'Elias', name: '墨讲师', desc: '既保持学科严谨性，又通过叙事技巧将复杂知识转化为可消化的认知模块（女性）' },
      { id: 'Arthur', name: '徐大爷', desc: '被岁月和旱烟浸泡过的质朴嗓音，不疾不徐地摇开了满村的奇闻异事（男性）' },
      { id: 'Nini', name: '邻家妹妹', desc: '糯米糍一样又软又黏的嗓音，那一声声拉长了的“哥哥”，甜得能把人的骨头都叫酥了（女性）' },
      { id: 'Seren', name: '小婉', desc: '温和舒缓的声线，助你更快地进入睡眠，晚安，好梦（女性）' },
      { id: 'Pip', name: '顽屁小孩', desc: '调皮捣蛋却充满童真的他来了，这是你记忆中的小新吗（男性）' },
      { id: 'Stella', name: '少女阿月', desc: '平时是甜到发腻的迷糊少女音，但在喊出“代表月亮消灭你”时，瞬间充满不容置疑的爱与正义（女性）' },
      { id: 'Bodega', name: '博德加', desc: '热情的西班牙大叔（男性）' },
      { id: 'Sonrisa', name: '索尼莎', desc: '热情开朗的拉美大姐（女性）' },
      { id: 'Alek', name: '阿列克', desc: '一开口，是战斗民族的冷，也是毛呢大衣下的暖（男性）' },
      { id: 'Dolce', name: '多尔切', desc: '慵懒的意大利大叔（男性）' },
      { id: 'Sohee', name: '素熙', desc: '温柔开朗，情绪丰富的韩国欧尼（女性）' },
      { id: 'Ono Anna', name: '小野杏', desc: '鬼灵精怪的青梅竹马（女性）' },
      { id: 'Lenn', name: '莱恩', desc: '理性是底色，叛逆藏在细节里——穿西装也听后朋克的德国青年（男性）' },
      { id: 'Emilien', name: '埃米尔安', desc: '浪漫的法国大哥哥（男性）' },
      { id: 'Andre', name: '安德雷', desc: '声音磁性，自然舒服、沉稳男生（男性）' },
      { id: 'Radio Gol', name: '拉迪奥·戈尔', desc: '足球诗人' },
      { id: 'Jada', name: '上海-阿珍', desc: '风风火火的沪上阿姐（女性）' },
      { id: 'Dylan', name: '北京-晓东', desc: '北京胡同里长大的少年（男性）' },
      { id: 'Li', name: '南京-老李', desc: '耐心的瑜伽老师（男性）' },
      { id: 'Marcus', name: '陕西-秦川', desc: '面宽话短，心实声沉——老陕的味道（男性）' },
      { id: 'Roy', name: '闽南-阿杰', desc: '诙谐直爽、市井活泼的台湾哥仔形象（男性）' },
      { id: 'Peter', name: '天津-李彼得', desc: '天津相声，专业捧哏（男性）' },
      { id: 'Sunny', name: '四川-晴儿', desc: '甜到你心里的川妹子（女性）' },
      { id: 'Eric', name: '四川-程川', desc: '一个跳脱市井的四川成都男子（男性）' },
      { id: 'Rocky', name: '粤语-阿强', desc: '幽默风趣的阿强，在线陪聊（男性）' },
      { id: 'Kiki', name: '粤语-阿清', desc: '甜美的港妹闺蜜（女性）' },
    ]
  },
]

/** CosyVoice V1 系统音色（无后缀 id） */
export const cosyvoiceV1Voices: VoiceGroup[] = [
  {
    label: '系统音色',
    voices: [
      { id: 'longwan', name: '龙婉', desc: '中文' },
      { id: 'longcheng', name: '龙橙', desc: '中文' },
      { id: 'longhua', name: '龙华', desc: '中文' },
      { id: 'longxiaochun', name: '龙小淳', desc: '中文、英文' },
      { id: 'longxiaoxia', name: '龙小夏', desc: '中文' },
      { id: 'longxiaocheng', name: '龙小诚', desc: '中文、英文' },
      { id: 'longxiaobai', name: '龙小白', desc: '中文' },
      { id: 'longlaotie', name: '龙老铁', desc: '中文东北口音' },
      { id: 'longshu', name: '龙书', desc: '中文' },
      { id: 'longshuo', name: '龙硕', desc: '中文' },
      { id: 'longjing', name: '龙婧', desc: '中文' },
      { id: 'longmiao', name: '龙妙', desc: '中文' },
      { id: 'longyue', name: '龙悦', desc: '中文' },
      { id: 'longyuan', name: '龙媛', desc: '中文' },
      { id: 'longfei', name: '龙飞', desc: '中文' },
      { id: 'longjielidou', name: '龙杰力豆', desc: '中文、英文' },
      { id: 'longtong', name: '龙彤', desc: '中文' },
      { id: 'longxiang', name: '龙祥', desc: '中文' },
      { id: 'loongstella', name: 'Stella', desc: '中文、英文' },
      { id: 'loongbella', name: 'Bella', desc: '中文' },
    ]
  },
]

/** CosyVoice V2 系统音色（无后缀 + _v2 后缀） */
export const cosyvoiceV2Voices: VoiceGroup[] = [
  {
    label: '电话销售',
    voices: [
      { id: 'longyingxiao', name: '龙应笑', desc: '清甜推销女' },
    ]
  },
  {
    label: '短视频配音',
    voices: [
      { id: 'longjiqi', name: '龙机器', desc: '呆萌机器人' },
      { id: 'longhouge', name: '龙猴哥', desc: '经典猴哥' },
      { id: 'longjixin', name: '龙机心', desc: '毒舌心机女' },
      { id: 'longanyue', name: '龙安粤', desc: '欢脱粤语男' },
      { id: 'longshange', name: '龙陕哥', desc: '原味陕北男' },
      { id: 'longanmin', name: '龙安敏', desc: '甜美闽南女' },
      { id: 'longdaiyu', name: '龙黛玉', desc: '娇率才女音' },
      { id: 'longgaoseng', name: '龙高僧', desc: '得道高僧音' },
    ]
  },
  {
    label: '语音助手',
    voices: [
      { id: 'longanli', name: '龙安莉', desc: '利落从容女' },
      { id: 'longanlang', name: '龙安朗', desc: '清爽利落男' },
      { id: 'longanwen', name: '龙安温', desc: '优雅知性女' },
      { id: 'longanyun', name: '龙安昀', desc: '居家暖男' },
      { id: 'longyumi_v2', name: 'YUMI', desc: '正经青年女' },
      { id: 'longxiaochun_v2', name: '龙小淳', desc: '知性积极女' },
      { id: 'longxiaoxia_v2', name: '龙小夏', desc: '沉稳权威女' },
    ]
  },
  {
    label: '有声书',
    voices: [
      { id: 'longyichen', name: '龙逸尘', desc: '洒脱活力男' },
      { id: 'longwanjun', name: '龙婉君', desc: '细腻柔声女' },
      { id: 'longlaobo', name: '龙老伯', desc: '沧桑岁月爷' },
      { id: 'longlaoyi', name: '龙老姨', desc: '烟火从容阿姨' },
      { id: 'longbaizhi', name: '龙白芷', desc: '睿气旁白女' },
      { id: 'longsanshu', name: '龙三叔', desc: '沉稳质感男' },
      { id: 'longxiu_v2', name: '龙修', desc: '博才说书男' },
      { id: 'longmiao_v2', name: '龙妙', desc: '抑扬顿挫女' },
      { id: 'longyue_v2', name: '龙悦', desc: '温暖磁性女' },
      { id: 'longnan_v2', name: '龙楠', desc: '睿智青年男' },
      { id: 'longyuan_v2', name: '龙媛', desc: '温暖治愈女' },
    ]
  },
  {
    label: '社交陪伴',
    voices: [
      { id: 'longanqin', name: '龙安亲', desc: '亲和活泼女' },
      { id: 'longanya', name: '龙安雅', desc: '高雅气质女' },
      { id: 'longanshuo', name: '龙安朔', desc: '干净清爽男' },
      { id: 'longanling', name: '龙安灵', desc: '思维灵动女' },
      { id: 'longanzhi', name: '龙安智', desc: '睿智轻熟男' },
      { id: 'longanrou', name: '龙安柔', desc: '温柔闺蜜女' },
      { id: 'longqiang_v2', name: '龙嫱', desc: '浪漫风情女' },
      { id: 'longhan_v2', name: '龙寒', desc: '温暖痴情男' },
      { id: 'longxing_v2', name: '龙星', desc: '温婉邻家女' },
      { id: 'longhua_v2', name: '龙华', desc: '元气甜美女' },
      { id: 'longwan_v2', name: '龙婉', desc: '积极知性女' },
      { id: 'longcheng_v2', name: '龙橙', desc: '智慧青年男' },
      { id: 'longfeifei_v2', name: '龙菲菲', desc: '甜美娇气女' },
      { id: 'longxiaocheng_v2', name: '龙小诚', desc: '磁性低音男' },
      { id: 'longzhe_v2', name: '龙哲', desc: '呆板大暖男' },
      { id: 'longyan_v2', name: '龙颜', desc: '温暖春风女' },
      { id: 'longtian_v2', name: '龙天', desc: '磁性理智男' },
      { id: 'longze_v2', name: '龙泽', desc: '温暖元气男' },
      { id: 'longshao_v2', name: '龙邵', desc: '积极向上男' },
      { id: 'longhao_v2', name: '龙浩', desc: '多情忧郁男' },
      { id: 'kabuleshen_v2', name: '龙深', desc: '实力歌手男' },
      { id: 'longhuhu', name: '龙呼呼', desc: '天真烂漫女童' },
      { id: 'longanpei', name: '龙安培', desc: '青少年教师女' },
    ]
  },
  {
    label: '消费电子-儿童陪伴',
    voices: [
      { id: 'longwangwang', name: '龙汪汪', desc: '台湾少年音' },
      { id: 'longpaopao', name: '龙泡泡', desc: '飞天泡泡音' },
    ]
  },
  {
    label: '消费电子-儿童有声书',
    voices: [
      { id: 'longshanshan', name: '龙闪闪', desc: '戏剧化童声' },
      { id: 'longniuniu', name: '龙牛牛', desc: '阳光男童声' },
    ]
  },
  {
    label: '客服',
    voices: [
      { id: 'longyingmu', name: '龙应沐', desc: '优雅知性女' },
      { id: 'longyingxun', name: '龙应询', desc: '年轻青涩男' },
      { id: 'longyingcui', name: '龙应催', desc: '严肃催收男' },
      { id: 'longyingda', name: '龙应答', desc: '开朗高音女' },
      { id: 'longyingjing', name: '龙应静', desc: '低调冷静女' },
      { id: 'longyingyan', name: '龙应严', desc: '义正严辞女' },
      { id: 'longyingtian', name: '龙应甜', desc: '温柔甜美女' },
      { id: 'longyingbing', name: '龙应冰', desc: '尖锐强势女' },
      { id: 'longyingtao', name: '龙应桃', desc: '温柔淡定女' },
      { id: 'longyingling', name: '龙应聆', desc: '温和共情女' },
    ]
  },
  {
    label: '直播带货',
    voices: [
      { id: 'longanran', name: '龙安燃', desc: '活泼质感女' },
      { id: 'longanxuan', name: '龙安宣', desc: '经典直播女' },
      { id: 'longanchong', name: '龙安冲', desc: '激情推销男' },
      { id: 'longanping', name: '龙安萍', desc: '高亢直播女' },
    ]
  },
  {
    label: '童声',
    voices: [
      { id: 'longjielidou_v2', name: '龙杰力豆', desc: '阳光顽皮男' },
      { id: 'longling_v2', name: '龙铃', desc: '稚气呆板女' },
      { id: 'longke_v2', name: '龙可', desc: '懵懂乖乖女' },
      { id: 'longxian_v2', name: '龙仙', desc: '豪放可爱女' },
    ]
  },
  {
    label: '方言',
    voices: [
      { id: 'longlaotie_v2', name: '龙老铁', desc: '东北直率男' },
      { id: 'longjiayi_v2', name: '龙嘉怡', desc: '知性粤语女' },
      { id: 'longtao_v2', name: '龙桃', desc: '积极粤语女' },
    ]
  },
  {
    label: '诗词朗诵',
    voices: [
      { id: 'longfei_v2', name: '龙飞', desc: '热血磁性男' },
      { id: 'libai_v2', name: '李白', desc: '古代诗仙男' },
      { id: 'longjin_v2', name: '龙津', desc: '优雅温润男' },
    ]
  },
  {
    label: '新闻播报',
    voices: [
      { id: 'longshu_v2', name: '龙书', desc: '沉稳青年男' },
      { id: 'loongbella_v2', name: 'Bella2.0', desc: '精准干练女' },
      { id: 'longshuo_v2', name: '龙硕', desc: '博才干练男' },
      { id: 'longxiaobai_v2', name: '龙小白', desc: '沉稳播报女' },
      { id: 'longjing_v2', name: '龙婧', desc: '典型播音女' },
      { id: 'loongstella_v2', name: 'loongstella', desc: '飒爽利落女' },
    ]
  },
  {
    label: '出海营销',
    voices: [
      { id: 'loongyuuna_v2', name: 'loongyuuna', desc: '元气霓虹女' },
      { id: 'loongyuuma_v2', name: 'loongyuuma', desc: '干练霓虹男' },
      { id: 'loongjihun_v2', name: 'loongjihun', desc: '阳光韩国男' },
      { id: 'loongeva_v2', name: 'loongeva', desc: '知性英文女' },
      { id: 'loongbrian_v2', name: 'loongbrian', desc: '沉稳英文男' },
      { id: 'loongluna_v2', name: 'loongluna', desc: '英式英文女' },
      { id: 'loongluca_v2', name: 'loongluca', desc: '英式英文男' },
      { id: 'loongemily_v2', name: 'loongemily', desc: '英式英文女' },
      { id: 'loongeric_v2', name: 'loongeric', desc: '英式英文男' },
      { id: 'loongabby_v2', name: 'loongabby', desc: '美式英文女' },
      { id: 'loongannie_v2', name: 'loongannie', desc: '美式英文女' },
      { id: 'loongandy_v2', name: 'loongandy', desc: '美式英文男' },
      { id: 'loongava_v2', name: 'loongava', desc: '美式英文女' },
      { id: 'loongbeth_v2', name: 'loongbeth', desc: '美式英文女' },
      { id: 'loongbetty_v2', name: 'loongbetty', desc: '美式英文女' },
      { id: 'loongcindy_v2', name: 'loongcindy', desc: '美式英文女' },
      { id: 'loongcally_v2', name: 'loongcally', desc: '美式英文女' },
      { id: 'loongdavid_v2', name: 'loongdavid', desc: '美式英文男' },
      { id: 'loongdonna_v2', name: 'loongdonna', desc: '美式英文女' },
      { id: 'loongkyong_v2', name: 'loongkyong', desc: '韩语女' },
      { id: 'loongtomoka_v2', name: 'loongtomoka', desc: '日语女' },
      { id: 'loongtomoya_v2', name: 'loongtomoya', desc: '日语男' },
    ]
  },
]

/** CosyVoice V3-Plus 标杆音色（与 v3-flash 同名同 id） */
export const cosyvoiceV3PlusVoices: VoiceGroup[] = [
  {
    label: '社交陪伴（标杆音色）',
    voices: [
      { id: 'longanyang', name: '龙安洋', desc: '阳光大男孩' },
      { id: 'longanhuan', name: '龙安欢', desc: '欢脱元气女' },
    ]
  },
]

/** CosyVoice V3-Flash 系统音色（_v3 后缀为主） */
export const cosyvoiceV3FlashVoices: VoiceGroup[] = [
  {
    label: '社交陪伴（标杆音色）',
    voices: [
      { id: 'longanyang', name: '龙安洋', desc: '阳光大男孩' },
      { id: 'longanhuan_v3', name: '龙安欢（V3）', desc: '欢脱元气女' },
      { id: 'longanhuan', name: '龙安欢', desc: '欢脱元气女' },
      { id: 'longhuhu_v3', name: '龙呼呼', desc: '天真烂漫女童' },
    ]
  },
  {
    label: '智能玩具/儿童故事机',
    voices: [
      { id: 'longpaopao_v3', name: '龙泡泡', desc: '飞天泡泡音' },
      { id: 'longjielidou_v3', name: '龙杰力豆', desc: '阳光顽皮男' },
      { id: 'longxian_v3', name: '龙仙', desc: '豪放可爱女' },
      { id: 'longling_v3', name: '龙铃', desc: '稚气呆板女' },
    ]
  },
  {
    label: '消费电子-儿童有声书',
    voices: [
      { id: 'longshanshan_v3', name: '龙闪闪', desc: '戏剧化童声' },
      { id: 'longniuniu_v3', name: '龙牛牛', desc: '阳光男童声' },
    ]
  },
  {
    label: '方言',
    voices: [
      { id: 'longjiaxin_v3', name: '龙嘉欣', desc: '优雅粤语女' },
      { id: 'longjiayi_v3', name: '龙嘉怡', desc: '知性粤语女' },
      { id: 'longanyue_v3', name: '龙安粤', desc: '欢脱粤语男' },
      { id: 'longlaotie_v3', name: '龙老铁', desc: '东北直率男' },
      { id: 'longshange_v3', name: '龙陕哥', desc: '原味陕北男' },
      { id: 'longanmin_v3', name: '龙安闽', desc: '清纯萝莉女' },
    ]
  },
  {
    label: '出海营销',
    voices: [
      { id: 'loongkyong_v3', name: 'loongkyong', desc: '韩语女' },
      { id: 'loongriko_v3', name: 'Riko', desc: '二次元霓虹女' },
      { id: 'loongtomoka_v3', name: 'loongtomoka', desc: '日语女' },
      { id: 'loongabby_v3', name: 'loongabby', desc: '美式英文女' },
      { id: 'loongandy_v3', name: 'loongandy', desc: '美式英文男' },
      { id: 'loongannie_v3', name: 'loongannie', desc: '美式英文女' },
      { id: 'loongava_v3', name: 'loongava', desc: '美式英文女' },
      { id: 'loongbeth_v3', name: 'loongbeth', desc: '美式英文女' },
      { id: 'loongbetty_v3', name: 'loongbetty', desc: '美式英文女' },
      { id: 'loongcally_v3', name: 'loongcally', desc: '美式英文女' },
      { id: 'loongcindy_v3', name: 'loongcindy', desc: '美式英文女' },
      { id: 'loongdavid_v3', name: 'loongdavid', desc: '美式英文男' },
      { id: 'loongdonna_v3', name: 'loongdonna', desc: '美式英文女' },
      { id: 'loongemily_v3', name: 'loongemily', desc: '英式英文女' },
      { id: 'loongeric_v3', name: 'loongeric', desc: '英式英文男' },
      { id: 'loongluna_v3', name: 'loongluna', desc: '英式英文女' },
      { id: 'loongluca_v3', name: 'loongluca', desc: '英式英文男' },
      { id: 'loongtomoya_v3', name: 'loongtomoya', desc: '日语男' },
      { id: 'loongyuuna_v3', name: 'Yuuna', desc: '日语女' },
      { id: 'loongyuuma_v3', name: 'Yuuma', desc: '日语男' },
      { id: 'loongjihun_v3', name: 'Jihun', desc: '韩语男' },
      { id: 'loongindah_v3', name: 'loongindah', desc: '印尼女' },
      { id: 'longfei_v3', name: '龙飞', desc: '热血磁性男' },
      { id: 'longyingxiao_v3', name: '龙应笑', desc: '清甜推销女' },
    ]
  },
  {
    label: '客服',
    voices: [
      { id: 'longyingxun_v3', name: '龙应询', desc: '年轻青涩男' },
      { id: 'longyingjing_v3', name: '龙应静', desc: '低调冷静女' },
      { id: 'longyingling_v3', name: '龙应聆', desc: '温和共情女' },
      { id: 'longyingtao_v3', name: '龙应桃', desc: '温柔淡定女' },
    ]
  },
  {
    label: '语音助手',
    voices: [
      { id: 'longxiaochun_v3', name: '龙小淳', desc: '知性积极女' },
      { id: 'longxiaoxia_v3', name: '龙小夏', desc: '沉稳权威女' },
      { id: 'longyumi_v3', name: 'YUMI', desc: '正经青年女' },
      { id: 'longanyun_v3', name: '龙安昀', desc: '居家暖男' },
      { id: 'longanwen_v3', name: '龙安温', desc: '优雅知性女' },
      { id: 'longanli_v3', name: '龙安莉', desc: '利落从容女' },
      { id: 'longanlang_v3', name: '龙安朗', desc: '清爽利落男' },
      { id: 'longyingmu_v3', name: '龙应沐', desc: '优雅知性女' },
    ]
  },
  {
    label: '社交陪伴',
    voices: [
      { id: 'longantai_v3', name: '龙安台', desc: '嗲甜台湾女' },
      { id: 'longhua_v3', name: '龙华', desc: '元气甜美女' },
      { id: 'longcheng_v3', name: '龙橙', desc: '智慧青年男' },
      { id: 'longze_v3', name: '龙泽', desc: '温暖元气男' },
      { id: 'longzhe_v3', name: '龙哲', desc: '呆板大暖男' },
      { id: 'longyan_v3', name: '龙颜', desc: '温暖春风女' },
      { id: 'longxing_v3', name: '龙星', desc: '温婉邻家女' },
      { id: 'longtian_v3', name: '龙天', desc: '磁性理智男' },
      { id: 'longwan_v3', name: '龙婉', desc: '细腻柔声女' },
      { id: 'longqiang_v3', name: '龙嫱', desc: '浪漫风情女' },
      { id: 'longfeifei_v3', name: '龙菲菲', desc: '甜美娇气女' },
      { id: 'longhao_v3', name: '龙浩', desc: '多情忧郁男' },
      { id: 'longanrou_v3', name: '龙安柔', desc: '温柔闺蜜女' },
      { id: 'longhan_v3', name: '龙寒', desc: '温暖痴情男' },
      { id: 'longanzhi_v3', name: '龙安智', desc: '睿智轻熟男' },
      { id: 'longanling_v3', name: '龙安灵', desc: '思维灵动女' },
      { id: 'longanya_v3', name: '龙安雅', desc: '高雅气质女' },
      { id: 'longanqin_v3', name: '龙安亲', desc: '亲和活泼女' },
    ]
  },
  {
    label: '有声书',
    voices: [
      { id: 'longmiao_v3', name: '龙妙', desc: '抑扬顿挫女' },
      { id: 'longsanshu_v3', name: '龙三叔', desc: '沉稳质感男' },
      { id: 'longyuan_v3', name: '龙媛', desc: '温暖治愈女' },
      { id: 'longyue_v3', name: '龙悦', desc: '温暖磁性女' },
      { id: 'longxiu_v3', name: '龙修', desc: '博才说书男' },
      { id: 'longnan_v3', name: '龙楠', desc: '睿智青年男' },
      { id: 'longwanjun_v3', name: '龙婉君', desc: '细腻柔声女' },
      { id: 'longyichen_v3', name: '龙逸尘', desc: '洒脱活力男' },
      { id: 'longlaobo_v3', name: '龙老伯', desc: '沧桑岁月爷' },
      { id: 'longlaoyi_v3', name: '龙老姨', desc: '烟火从容阿姨' },
    ]
  },
  {
    label: '短视频配音',
    voices: [
      { id: 'longjiqi_v3', name: '龙机器', desc: '呆萌机器人' },
      { id: 'longhouge_v3', name: '龙猴哥', desc: '经典猴哥' },
      { id: 'longdaiyu_v3', name: '龙黛玉', desc: '娇率才女音' },
    ]
  },
  {
    label: '直播带货',
    voices: [
      { id: 'longanran_v3', name: '龙安燃', desc: '活泼质感女' },
      { id: 'longanxuan_v3', name: '龙安宣', desc: '经典直播女' },
    ]
  },
  {
    label: '新闻播报',
    voices: [
      { id: 'longshuo_v3', name: '龙硕', desc: '博才干练男' },
      { id: 'longshu_v3', name: '龙书', desc: '沉稳青年男' },
      { id: 'loongbella_v3', name: 'Bella3.0', desc: '精准干练女' },
    ]
  },
]
