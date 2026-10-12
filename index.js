/**
 * Veilweaver — вуаль для сгенерированных картинок Frameweaver и Sideweaver.
 * Форк ST-ImageBlur (Nufahi), переписанный так, чтобы не вешать таверну.
 *
 * Принципы:
 *  - Блюр делает CSS по классу на <body>. Сами картинки и их классы мы не трогаем.
 *  - Открытые картинки — это правила в нашем <style> в <head> (по адресу картинки),
 *    клик по глазу меняет только его текст. В чат при этом не пишется ничего.
 *  - Единственная запись в чужой DOM — кнопка-глаз, один раз на обёртку и только
 *    если её там ещё нет. Поэтому повторный проход ничего не меняет и зациклиться не может.
 *
 * Этап 1: настройки, панель, CSS-блюр, глушение кликов по мутным картинкам.
 * Этап 2: глазики во Фрейме и Сайде, память открытых картинок до перезагрузки.
 */
(function () {
    'use strict';

    const SETTINGS_KEY = 'veilweaver';
    const LOG = '[Veilweaver]';
    const BODY_CLASS = 'vlw-on';
    const EYE_CLASS = 'vlw-eye';
    const REVEALED_STYLE_ID = 'vlw_revealed_style';

    // Картинки под вуалью. Те же селекторы продублированы в style.css — меняются парой.
    const VEIL_SELECTOR = [
        '#chat .mes_text img.iig-generated-image:not(.iig-error-image):not([src*="error.svg"])',
        '#chat .mes_text img[data-iig-instruction]:not(.iig-error-image):not([src*="error.svg"])',
        '#sdw_image',
    ].join(', ');

    // Обёртки, куда садится глаз.
    const FW_WRAPPER = '#chat .iig-image-wrapper:not(.iig-placeholder-wrapper)';
    const SDW_WRAPPER = '#sdw_image_wrap';

    // Кнопка «развернуть» Фрейма — у мутной картинки её глушим.
    const FW_VIEW_BUTTON = '#chat .iig-image-wrapper .iig-action-view';

    // Ровно та же проверка, что во Фрейме (USE_TAP_IMAGE_ACTIONS): в тап-режиме тап по
    // картинке показывает его кнопки, а лайтбокс не открывается — такой тап не трогаем.
    const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const IS_MOBILE = IS_IOS
        || /Android|webOS|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent)
        || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
    const FW_TAP_MODE = IS_MOBILE || !!window.matchMedia?.('(hover: none), (pointer: coarse)')?.matches;

    const TEXT = {
        reveal: 'Показать картинку',
        hide: 'Спрятать картинку',
    };

    const DEFAULTS = Object.freeze({ enabled: true, blur: 28, dim: 45 });
    const BLUR_RANGE = [8, 50];
    const DIM_RANGE = [20, 100];

    if (window.__veilweaverDispose) window.__veilweaverDispose();

    const ctx = () => window.SillyTavern?.getContext?.();
    const clamp = (value, [min, max], fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

    /** Адреса открытых картинок. Живут только в памяти вкладки — F5, и всё снова мутное. */
    const revealed = new Set();
    let observer = null;
    let passScheduled = false;

    // ───────────────────────────── Настройки ─────────────────────────────

    function settings() {
        const store = ctx()?.extensionSettings;
        if (!store) return { ...DEFAULTS };
        const value = store[SETTINGS_KEY] ??= { ...DEFAULTS };
        if (typeof value.enabled !== 'boolean') value.enabled = DEFAULTS.enabled;
        value.blur = clamp(value.blur, BLUR_RANGE, DEFAULTS.blur);
        value.dim = clamp(value.dim, DIM_RANGE, DEFAULTS.dim);
        return value;
    }

    function save() {
        ctx()?.saveSettingsDebounced?.();
    }

    // ───────────────────────────── Вуаль ─────────────────────────────

    /** Класс и переменные на <body> + включение/выключение наблюдателя. */
    function applyVeil() {
        const state = settings();
        const body = document.body;
        body.style.setProperty('--vlw-blur', `${state.blur}px`);
        body.style.setProperty('--vlw-dim', String(state.dim / 100));
        if (body.classList.contains(BODY_CLASS) !== state.enabled) body.classList.toggle(BODY_CLASS, state.enabled);
        if (state.enabled) startWatching();
        else stopWatching();
    }

    function imageKey(image) {
        return image?.getAttribute('src') || '';
    }

    function isVeiled(image) {
        return settings().enabled
            && image instanceof HTMLImageElement
            && image.matches(VEIL_SELECTOR)
            && !revealed.has(imageKey(image));
    }

    /**
     * Пересобирает правила «вот эти адреса не мутить».
     * Два :not(#…) поднимают специфичность выше правила вуали из style.css.
     */
    function renderRevealedStyle() {
        let style = document.getElementById(REVEALED_STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = REVEALED_STYLE_ID;
            document.head.appendChild(style);
        }
        const boost = ':not(#vlw-a):not(#vlw-b)';
        style.textContent = [...revealed].map((src) => {
            const attr = `[src="${CSS.escape(src)}"]`;
            return `body.${BODY_CLASS} img${attr}${boost} { filter: none !important; cursor: zoom-in; }
:is(.iig-image-wrapper, #sdw_image_wrap):has(> img${attr}) > .${EYE_CLASS} .vlw-ico-reveal { display: none; }
:is(.iig-image-wrapper, #sdw_image_wrap):has(> img${attr}) > .${EYE_CLASS} .vlw-ico-hide { display: inline-block; }`;
        }).join('\n');
    }

    // ───────────────────────────── Глазики ─────────────────────────────

    function eyeLabel(image) {
        return revealed.has(imageKey(image)) ? TEXT.hide : TEXT.reveal;
    }

    function createEye(extraClass) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${EYE_CLASS} ${extraClass}`;
        button.innerHTML = '<i class="fa-solid fa-eye vlw-ico-reveal" aria-hidden="true"></i><i class="fa-solid fa-eye-slash vlw-ico-hide" aria-hidden="true"></i>';
        return button;
    }

    function setEyeLabel(button, image) {
        const label = eyeLabel(image);
        if (button.title !== label) {
            button.title = label;
            button.setAttribute('aria-label', label);
        }
    }

    /** Вставляет глаз туда, где его нет. Где есть — не трогает (идемпотентно). */
    function ensureEyes() {
        passScheduled = false;
        if (!settings().enabled) return;

        for (const wrapper of document.querySelectorAll(FW_WRAPPER)) {
            if (wrapper.querySelector(`:scope > .${EYE_CLASS}`)) continue;
            const image = wrapper.querySelector(':scope > img');
            if (!image || !image.matches(VEIL_SELECTOR)) continue;
            const eye = createEye('iig-action-btn vlw-eye-fw');
            setEyeLabel(eye, image);
            wrapper.appendChild(eye);
        }

        const sdwWrap = document.querySelector(SDW_WRAPPER);
        if (sdwWrap && !sdwWrap.querySelector(`:scope > .${EYE_CLASS}`)) {
            const eye = createEye('vlw-eye-sdw');
            setEyeLabel(eye, sdwWrap.querySelector(':scope > img'));
            sdwWrap.appendChild(eye);
        }
    }

    function schedulePass() {
        if (passScheduled) return;
        passScheduled = true;
        requestAnimationFrame(ensureEyes);
    }

    const isOwnNode = (node) => node instanceof Element && (node.classList.contains(EYE_CLASS) || !!node.closest(`.${EYE_CLASS}`));

    function onMutations(records) {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element && !isOwnNode(node)) {
                    schedulePass();
                    return;
                }
            }
        }
    }

    /** Наблюдаем только когда вуаль включена: дома расширение вообще ничего не делает. */
    function startWatching() {
        if (!observer) {
            observer = new MutationObserver(onMutations);
            const chat = document.getElementById('chat');
            if (chat) observer.observe(chat, { childList: true, subtree: true });
            // Окно Сайда вставляется прямо в <body> — ловим его появление без subtree.
            observer.observe(document.body, { childList: true });
        }
        schedulePass();
    }

    function stopWatching() {
        observer?.disconnect();
        observer = null;
    }

    function toggleImage(button) {
        const image = button.parentElement?.querySelector(':scope > img');
        const key = imageKey(image);
        if (!key) return;
        if (revealed.has(key)) revealed.delete(key);
        else revealed.add(key);
        renderRevealedStyle();
        setEyeLabel(button, image);
    }

    // ───────────────────────────── Клики ─────────────────────────────

    function swallow(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    /**
     * Слушаем window в фазе захвата — раньше и Фрейма (#chat), и Сайда (сама картинка).
     * Глаз: открыть/спрятать. Мутная картинка: на весь экран не открывается.
     */
    function onClickCapture(event) {
        if (!settings().enabled || !(event.target instanceof Element)) return;
        const target = event.target;

        const eye = target.closest(`.${EYE_CLASS}`);
        if (eye) {
            swallow(event);
            toggleImage(eye);
            return;
        }

        const viewButton = target.closest(FW_VIEW_BUTTON);
        if (viewButton) {
            const image = viewButton.parentElement?.querySelector(':scope > img');
            if (image && isVeiled(image)) swallow(event);
            return;
        }

        if (!isVeiled(target)) return;
        if (target.id === 'sdw_image') return swallow(event);
        if (!FW_TAP_MODE) swallow(event);
    }

    // ───────────────────────────── Панель ─────────────────────────────

    function settingsHtml(state) {
        return `
            <div id="vlw_settings" class="vlw-settings">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b><i class="fa-solid fa-eye-slash"></i> Veilweaver</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <div class="vlw-card">
                            <label class="vlw-row">
                                <span class="vlw-copy">
                                    <strong>Вуаль</strong>
                                    <small>Прятать сгенерированные картинки под блюр.</small>
                                </span>
                                <input id="vlw_enabled" type="checkbox" ${state.enabled ? 'checked' : ''}>
                            </label>
                            <label class="vlw-range">
                                <span class="vlw-range-head"><strong>Сила блюра</strong><output id="vlw_blur_value">${state.blur} px</output></span>
                                <input id="vlw_blur" type="range" min="${BLUR_RANGE[0]}" max="${BLUR_RANGE[1]}" step="1" value="${state.blur}">
                            </label>
                            <label class="vlw-range">
                                <span class="vlw-range-head"><strong>Яркость скрытой картинки</strong><output id="vlw_dim_value">${state.dim} %</output></span>
                                <input id="vlw_dim" type="range" min="${DIM_RANGE[0]}" max="${DIM_RANGE[1]}" step="5" value="${state.dim}">
                            </label>
                            <p class="vlw-hint"><i class="fa-solid fa-circle-info"></i> Глазик в левом нижнем углу картинки открывает и прячет её. Открытые картинки помнятся до перезагрузки страницы. Работает с Frameweaver и Sideweaver.</p>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    function addSettings() {
        if (document.getElementById('vlw_settings')) return true;
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host) return false;
        host.insertAdjacentHTML('beforeend', settingsHtml(settings()));
        const panel = document.getElementById('vlw_settings');

        panel.querySelector('#vlw_enabled').addEventListener('change', (event) => {
            settings().enabled = event.target.checked;
            save();
            applyVeil();
        });
        panel.querySelector('#vlw_blur').addEventListener('input', (event) => {
            settings().blur = Number(event.target.value);
            panel.querySelector('#vlw_blur_value').value = `${event.target.value} px`;
            save();
            applyVeil();
        });
        panel.querySelector('#vlw_dim').addEventListener('input', (event) => {
            settings().dim = Number(event.target.value);
            panel.querySelector('#vlw_dim_value').value = `${event.target.value} %`;
            save();
            applyVeil();
        });
        return true;
    }

    // ───────────────────────────── Старт ─────────────────────────────

    function init() {
        settings();
        renderRevealedStyle();
        applyVeil();

        let settingsTimer = null;
        if (!addSettings()) {
            settingsTimer = setInterval(() => { if (addSettings()) clearInterval(settingsTimer); }, 500);
        }
        window.addEventListener('click', onClickCapture, true);

        window.__veilweaverDispose = () => {
            clearInterval(settingsTimer);
            stopWatching();
            window.removeEventListener('click', onClickCapture, true);
            document.body.classList.remove(BODY_CLASS);
            document.body.style.removeProperty('--vlw-blur');
            document.body.style.removeProperty('--vlw-dim');
            document.getElementById(REVEALED_STYLE_ID)?.remove();
            document.querySelectorAll(`.${EYE_CLASS}`).forEach((eye) => eye.remove());
            document.getElementById('vlw_settings')?.remove();
            delete window.__veilweaverDispose;
        };
        console.log(`${LOG} готов, вуаль ${settings().enabled ? 'включена' : 'выключена'}.`);
    }

    if (window.jQuery) window.jQuery(init);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
