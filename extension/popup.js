
const $  = id  => document.getElementById(id);
const qq = sel => document.querySelector(sel);


function show(page){
  $('page_main').classList.toggle('hidden', page !== 'main');
  $('page_timeouts').classList.toggle('hidden', page !== 'timeouts');
}
$('open_timeouts').addEventListener('click', () => show('timeouts'));
$('back_main_t').addEventListener('click', () => show('main'));


const defaults = {
  enabled:true, recaptcha:true, autoclick:true, images:true,
  click_delay:300, reveal_delay:850, verify_delay:850
};

chrome.storage.local.get('settings').then(({ settings = {} }) => {
  const ui = { ...defaults };
  ui.enabled      = settings.enabled ?? defaults.enabled;
  ui.autoclick    = settings.recaptcha_auto_open  ?? defaults.autoclick;
  ui.images       = settings.recaptcha_auto_solve ?? defaults.images;
  ui.click_delay  = settings.recaptcha_delay_between_clicks ?? defaults.click_delay;
  ui.reveal_delay = settings.recaptcha_delay_dynamic_reveal ?? defaults.reveal_delay;
  ui.verify_delay = settings.recaptcha_delay_before_verify  ?? defaults.verify_delay;
  ui.recaptcha    = ui.autoclick || ui.images;

  $('enabled' ).checked = ui.enabled;
  $('recaptcha').checked = ui.recaptcha;
  $('autoclick').checked = ui.autoclick;
  $('images'   ).checked = ui.images;
  $('click_delay' ).value = ui.click_delay;
  $('reveal_delay').value = ui.reveal_delay;
  $('verify_delay').value = ui.verify_delay;
});

['enabled','recaptcha','autoclick','images'].forEach(id => {
  $(id).addEventListener('change', () => save(readUI()));
});
['click_delay','reveal_delay','verify_delay'].forEach(id => {
  $(id).addEventListener('input', () => save(readUI()));
});

function readUI () {
  return {
    enabled:      $('enabled').checked,
    recaptcha:    $('recaptcha').checked,
    autoclick:    $('autoclick').checked,
    images:       $('images').checked,
    click_delay:  Math.max(0, Number($('click_delay').value)  || 0),
    reveal_delay: Math.max(0, Number($('reveal_delay').value) || 0),
    verify_delay: Math.max(0, Number($('verify_delay').value) || 0)
  };
}
function save (ui) {
  const out = {
    enabled:                        ui.enabled,
    recaptcha_auto_open:            ui.recaptcha ? ui.autoclick : false,
    recaptcha_auto_solve:           ui.recaptcha ? ui.images    : false,
    recaptcha_delay_between_clicks: ui.click_delay,
    recaptcha_delay_dynamic_reveal: ui.reveal_delay,
    recaptcha_delay_before_verify:  ui.verify_delay
  };
  // settings::update merges into stored settings in the background (do NOT
  // storage.local.set here — that would wipe keys not present in `out`).
  chrome.runtime.sendMessage([Math.random().toString(36).slice(2),'settings::update',out]);
}
