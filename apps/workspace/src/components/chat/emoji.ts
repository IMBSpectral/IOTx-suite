/** Emoji with Slack-style :shortcodes:, grouped for the picker. */
const RAW: [string, string][] = [
  ["Smileys", "😀 grinning|😃 smiley|😄 smile|😁 grin|😆 laughing|😅 sweat_smile|🤣 rofl|😂 joy|🙂 slightly_smiling_face|🙃 upside_down_face|😉 wink|😊 blush|😇 innocent|🥰 smiling_face_with_hearts|😍 heart_eyes|🤩 star_struck|😘 kissing_heart|😋 yum|😛 stuck_out_tongue|😜 stuck_out_tongue_winking_eye|🤪 zany_face|🤑 money_mouth_face|🤗 hugging_face|🤭 hand_over_mouth|🤫 shushing_face|🤔 thinking_face|🤐 zipper_mouth_face|🤨 raised_eyebrow|😐 neutral_face|😑 expressionless|😶 no_mouth|😏 smirk|😒 unamused|🙄 eye_roll|😬 grimacing|😌 relieved|😔 pensive|😪 sleepy|😴 sleeping|😷 mask|🤒 face_with_thermometer|🤕 face_with_head_bandage|🤢 nauseated_face|🤧 sneezing_face|🥵 hot_face|🥶 cold_face|😵 dizzy_face|🤯 exploding_head|🤠 cowboy_hat_face|🥳 partying_face|😎 sunglasses|🤓 nerd_face|🧐 monocle_face|😕 confused|😟 worried|🙁 slightly_frowning_face|😮 open_mouth|😯 hushed|😲 astonished|😳 flushed|🥺 pleading_face|😦 frowning|😧 anguished|😨 fearful|😰 cold_sweat|😥 disappointed_relieved|😢 cry|😭 sob|😱 scream|😖 confounded|😣 persevere|😞 disappointed|😓 sweat|😩 weary|😫 tired_face|🥱 yawning_face|😤 triumph|😡 rage|😠 angry|🤬 cursing_face|😈 smiling_imp|💀 skull|💩 poop|🤡 clown_face|👻 ghost|👽 alien|🤖 robot_face|😺 smiley_cat|😹 joy_cat|😻 heart_eyes_cat|🙈 see_no_evil|🙉 hear_no_evil|🙊 speak_no_evil"],
  ["People", "👋 wave|🤚 raised_back_of_hand|✋ hand|🖖 spock-hand|👌 ok_hand|🤌 pinched_fingers|✌️ v|🤞 crossed_fingers|🤟 love_you_gesture|🤘 the_horns|🤙 call_me_hand|👈 point_left|👉 point_right|👆 point_up_2|👇 point_down|☝️ point_up|👍 +1|👎 -1|✊ fist|👊 punch|🤛 left-facing_fist|🤜 right-facing_fist|👏 clap|🙌 raised_hands|👐 open_hands|🤲 palms_up_together|🤝 handshake|🙏 pray|✍️ writing_hand|💅 nail_care|🤳 selfie|💪 muscle|🧠 brain|👀 eyes|👁️ eye|👅 tongue|👄 lips|👶 baby|🧒 child|👦 boy|👧 girl|🧑 adult|👨 man|👩 woman|🧓 older_adult|🙋 raising_hand|🙇 bow|🤦 facepalm|🤷 shrug|🧑‍💻 technologist|🧑‍🎨 artist|🧑‍🚀 astronaut|🧑‍🍳 cook|🦸 superhero|🧙 mage|🏃 runner|💃 dancer|🕺 man_dancing|👯 dancers|🧘 person_in_lotus_position"],
  ["Nature", "🐶 dog|🐱 cat|🐭 mouse|🐹 hamster|🐰 rabbit|🦊 fox_face|🐻 bear|🐼 panda_face|🐨 koala|🐯 tiger|🦁 lion_face|🐮 cow|🐷 pig|🐸 frog|🐵 monkey_face|🐔 chicken|🐧 penguin|🐦 bird|🦆 duck|🦅 eagle|🦉 owl|🐺 wolf|🐗 boar|🐴 horse|🦄 unicorn_face|🐝 bee|🐛 bug|🦋 butterfly|🐌 snail|🐞 ladybug|🐢 turtle|🐍 snake|🐙 octopus|🦀 crab|🐠 tropical_fish|🐬 dolphin|🐳 whale|🦈 shark|🐘 elephant|🦒 giraffe|🌵 cactus|🎄 christmas_tree|🌲 evergreen_tree|🌳 deciduous_tree|🌴 palm_tree|🌱 seedling|🌿 herb|🍀 four_leaf_clover|🍁 maple_leaf|🍂 fallen_leaf|🌷 tulip|🌹 rose|🌻 sunflower|🌸 cherry_blossom|💐 bouquet|🌞 sun_with_face|🌝 full_moon_with_face|🌙 crescent_moon|⭐ star|🌟 star2|✨ sparkles|⚡ zap|🔥 fire|🌈 rainbow|☀️ sunny|⛅ partly_sunny|☁️ cloud|🌧️ rain_cloud|⛈️ thunder_cloud_and_rain|❄️ snowflake|☃️ snowman|🌊 ocean|💧 droplet"],
  ["Food", "🍏 green_apple|🍎 apple|🍐 pear|🍊 tangerine|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥝 kiwifruit|🍅 tomato|🥑 avocado|🌶️ hot_pepper|🌽 corn|🥕 carrot|🥐 croissant|🍞 bread|🧀 cheese_wedge|🥚 egg|🍳 fried_egg|🥞 pancakes|🥓 bacon|🍔 hamburger|🍟 fries|🍕 pizza|🌭 hotdog|🌮 taco|🌯 burrito|🥗 green_salad|🍝 spaghetti|🍜 ramen|🍛 curry|🍣 sushi|🍱 bento|🥟 dumpling|🍚 rice|🍦 icecream|🍩 doughnut|🍪 cookie|🎂 birthday|🍰 cake|🧁 cupcake|🍫 chocolate_bar|🍬 candy|🍿 popcorn|☕ coffee|🍵 tea|🧃 beverage_box|🥤 cup_with_straw|🍺 beer|🍻 beers|🥂 clinking_glasses|🍷 wine_glass|🍸 cocktail|🍹 tropical_drink"],
  ["Activities", "⚽ soccer|🏀 basketball|🏈 football|⚾ baseball|🎾 tennis|🏐 volleyball|🏉 rugby_football|🎱 8ball|🏓 table_tennis_paddle_and_ball|🏸 badminton_racquet_and_shuttlecock|🏏 cricket_bat_and_ball|⛳ golf|🏹 bow_and_arrow|🎣 fishing_pole_and_fish|🥊 boxing_glove|🎽 running_shirt_with_sash|⛸️ ice_skate|🎿 ski|🏆 trophy|🥇 first_place_medal|🥈 second_place_medal|🥉 third_place_medal|🏅 sports_medal|🎖️ medal|🎗️ reminder_ribbon|🎫 ticket|🎪 circus_tent|🎭 performing_arts|🎨 art|🎬 clapper|🎤 microphone|🎧 headphones|🎼 musical_score|🎹 musical_keyboard|🥁 drum_with_drumsticks|🎷 saxophone|🎺 trumpet|🎸 guitar|🎻 violin|🎲 game_die|♟️ chess_pawn|🎯 dart|🎳 bowling|🎮 video_game|🧩 jigsaw|🎉 tada|🎊 confetti_ball|🎈 balloon|🎁 gift|🎀 ribbon"],
  ["Travel", "🚗 car|🚕 taxi|🚙 blue_car|🚌 bus|🏎️ racing_car|🚓 police_car|🚑 ambulance|🚒 fire_engine|🚚 truck|🚲 bike|🛴 scooter|🏍️ racing_motorcycle|🚨 rotating_light|🚄 bullettrain_side|🚆 train2|🚇 metro|✈️ airplane|🛫 airplane_departure|🛬 airplane_arriving|🚀 rocket|🛸 flying_saucer|🚁 helicopter|⛵ boat|🚢 ship|⚓ anchor|🗺️ world_map|🧭 compass|🏔️ snow_capped_mountain|🏕️ camping|🏖️ beach_with_umbrella|🏝️ desert_island|🏠 house|🏡 house_with_garden|🏢 office|🏥 hospital|🏦 bank|🏨 hotel|🏫 school|🏭 factory|🏰 european_castle|🗼 tokyo_tower|🗽 statue_of_liberty|⛪ church|🕌 mosque|🛕 hindu_temple|⛲ fountain|🌁 foggy|🌃 night_with_stars|🌅 sunrise|🌇 city_sunset|🎡 ferris_wheel|🎢 roller_coaster"],
  ["Objects", "⌚ watch|📱 iphone|💻 computer|⌨️ keyboard|🖥️ desktop_computer|🖨️ printer|🖱️ three_button_mouse|💾 floppy_disk|💿 cd|📷 camera|🎥 movie_camera|📞 telephone_receiver|☎️ phone|📺 tv|📻 radio|🎙️ studio_microphone|⏰ alarm_clock|⏳ hourglass_flowing_sand|⌛ hourglass|🔋 battery|🔌 electric_plug|💡 bulb|🔦 flashlight|🕯️ candle|💸 money_with_wings|💵 dollar|💰 moneybag|💳 credit_card|💎 gem|⚖️ scales|🔧 wrench|🔨 hammer|🛠️ hammer_and_wrench|⚙️ gear|🧰 toolbox|🧲 magnet|🧪 test_tube|🔬 microscope|🔭 telescope|💊 pill|💉 syringe|🩺 stethoscope|🚪 door|🛏️ bed|🛋️ couch_and_lamp|🚽 toilet|🧹 broom|🧺 basket|🧻 roll_of_paper|🛒 shopping_trolley|🎁 present|📦 package|📫 mailbox|📮 postbox|✉️ email|📧 e-mail|📨 incoming_envelope|📝 memo|📄 page_facing_up|📃 page_with_curl|📑 bookmark_tabs|📊 bar_chart|📈 chart_with_upwards_trend|📉 chart_with_downwards_trend|🗒️ spiral_note_pad|📅 date|📆 calendar|🗓️ spiral_calendar_pad|📇 card_index|📋 clipboard|📁 file_folder|📂 open_file_folder|🗂️ card_index_dividers|📌 pushpin|📍 round_pushpin|📎 paperclip|🖇️ linked_paperclips|📏 straight_ruler|✂️ scissors|🔒 lock|🔓 unlock|🔑 key|🗝️ old_key|📚 books|📖 book|🔖 bookmark|🏷️ label|✏️ pencil2|🖊️ lower_left_ballpoint_pen|🖌️ lower_left_paintbrush|🔍 mag|🔎 mag_right"],
  ["Symbols", "❤️ heart|🧡 orange_heart|💛 yellow_heart|💚 green_heart|💙 blue_heart|💜 purple_heart|🖤 black_heart|🤍 white_heart|💔 broken_heart|💕 two_hearts|💞 revolving_hearts|💯 100|✅ white_check_mark|☑️ ballot_box_with_check|✔️ heavy_check_mark|❌ x|❎ negative_squared_cross_mark|➕ heavy_plus_sign|➖ heavy_minus_sign|❓ question|❗ exclamation|‼️ bangbang|⁉️ interrobang|⚠️ warning|🚫 no_entry_sign|⛔ no_entry|🔴 red_circle|🟠 large_orange_circle|🟡 large_yellow_circle|🟢 large_green_circle|🔵 large_blue_circle|🟣 large_purple_circle|⚫ black_circle|⚪ white_circle|🟥 large_red_square|🟩 large_green_square|🟦 large_blue_square|⬆️ arrow_up|⬇️ arrow_down|⬅️ arrow_left|➡️ arrow_right|↩️ leftwards_arrow_with_hook|🔄 arrows_counterclockwise|🔁 repeat|▶️ arrow_forward|⏸️ double_vertical_bar|⏹️ black_square_for_stop|⏺️ black_circle_for_record|🔔 bell|🔕 no_bell|📣 mega|📢 loudspeaker|💬 speech_balloon|💭 thought_balloon|🗯️ right_anger_bubble|♻️ recycle|🆗 ok|🆕 new|🆒 cool|🆓 free|🆙 up|🔝 top|🔜 soon|ℹ️ information_source|🔗 link|#️⃣ hash|*️⃣ keycap_star|🏁 checkered_flag|🚩 triangular_flag_on_post|🏳️ waving_white_flag|🏴 waving_black_flag"],
];

export type Emoji = { e: string; n: string; c: string };
export const EMOJI: Emoji[] = RAW.flatMap(([c, s]) => s.split("|").map((x) => {
  const i = x.indexOf(" ");
  return { e: x.slice(0, i), n: x.slice(i + 1), c };
}));
export const CATEGORIES = RAW.map(([c]) => c);
const BY_NAME = new Map(EMOJI.map((x) => [x.n, x.e]));
// A few common aliases.
for (const [a, b] of [["thumbsup", "+1"], ["thumbsdown", "-1"], ["smiling", "slightly_smiling_face"], ["thinking", "thinking_face"], ["check", "white_check_mark"], ["party", "tada"], ["heart_hands", "pray"], ["laugh", "joy"], ["ok", "ok_hand"], ["rocket_ship", "rocket"], ["eyes_emoji", "eyes"]] as const) BY_NAME.set(a, BY_NAME.get(b)!);
export const emojiFor = (name: string) => BY_NAME.get(name.toLowerCase());
export const QUICK = ["👍", "✅", "👀", "🙌", "😂", "🎉"];

export function searchEmoji(q: string, limit = 60) {
  const t = q.toLowerCase().replace(/^:/, "");
  if (!t) return EMOJI.slice(0, limit);
  const starts = EMOJI.filter((x) => x.n.startsWith(t));
  const has = EMOJI.filter((x) => !x.n.startsWith(t) && x.n.includes(t));
  return [...starts, ...has].slice(0, limit);
}

const RECENT_KEY = "iotx.chat.emoji.recent";
export function recentEmoji(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").slice(0, 16);
  } catch {
    return [];
  }
}
export function noteEmoji(e: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 16)));
  } catch {}
}
