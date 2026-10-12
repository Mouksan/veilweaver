/**
 * Veilweaver — вуаль для сгенерированных картинок Frameweaver и Sideweaver.
 * Форк ST-ImageBlur (Nufahi), переписанный так, чтобы не вешать таверну.
 *
 * Принцип: блюр делает CSS по классу на <body>. Сами картинки, их обёртки и
 * классы мы не трогаем вообще — значит, нам не с кем зацикливаться.
 *
 * Этап 1: настройки, панель, CSS-блюр, глушение кликов по мутным картинкам.
 */
(function () {
    'use strict';

    const SETTINGS_KEY = 'veilweaver';
    const LOG = '[Veilweaver]';
    const BODY_CLASS = 'vlw-on';

    // Картинки под вуалью. Те же селекторы продублированы в style.css — меняются парой.
    const VEIL_SELECTOR = [
        '#chat .mes_text img.iig-generated-image:not(.iig-error-image):not([src*="error.svg"])',
        '#chat .mes_text img[data-iig-instruction]:not(.iig-error-image):not([src*="error.svg"])',
        '#sdw_image',
    ].join(', ');

    // Кнопка «развернуть» Фрейма — у мутной картинки её глушим.
    const FW_VIEW_BUTTON = '#chat .iig-image-wrapper .iig-action-view';

    // Ровно та же проверка, что во Фрейме (USE_TAP_IMAGE_ACTIONS): в тап-режиме тап по
    // картинке показывает его кнопки, а лайтбокс не открывается — такой тап не трогаем.
    const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const IS_MOBILE = IS_IOS
        || /Android|webOS|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent)
        || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
    const FW_TAP_MODE = IS_MOBILE || !!window.matchMedia?.('(hover: none), (pointer: coarse)')?.matches;

    const DEFAULTS = Object.freeze({ enabled: true, blur: 28, dim: 45 });
    const BLUR_RANGE = [8, 50];
    const DIM_RANGE = [20, 100];

    if (window.__veilweaverDispose) window.__veilweaverDispose();

    const ctx = () => window.SillyTavern?.getContext?.();
    const clamp = (value, [min, max], fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

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

    /** Единственное место, которое что-то пишет в DOM ради блюра: класс и переменные на <body>. */
    function applyVeil() {
        const state = settings();
        const body = document.body;
        body.style.setProperty('--vlw-blur', `${state.blur}px`);
        body.style.setProperty('--vlw-dim', String(state.dim / 100));
        if (body.classList.contains(BODY_CLASS) !== state.enabled) body.classList.toggle(BODY_CLASS, state.enabled);
    }

    function isVeiled(image) {
        return settings().enabled && image instanceof HTMLImageElement && image.matches(VEIL_SELECTOR);
    }

    function swallow(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    /**
     * Клик по мутной картинке не должен открыть её на весь экран.
     * Слушаем window в фазе захвата — раньше и Фрейма (#chat), и Сайда (сама картинка).
     */
    function onClickCapture(event) {
        if (!settings().enabled || !(event.target instanceof Element)) return;
        const target = event.target;

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
                                    <small>Прятать сгенерированные картинки Фрейма и Сайда под блюр.</small>
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
                            <p class="vlw-hint"><i class="fa-solid fa-circle-info"></i> Глазик в левом нижнем углу картинки открывает и прячет её. Открытые картинки помнятся до перезагрузки страницы.</p>
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

    function init() {
        settings();
        applyVeil();

        let settingsTimer = null;
        if (!addSettings()) {
            settingsTimer = setInterval(() => { if (addSettings()) clearInterval(settingsTimer); }, 500);
        }
        window.addEventListener('click', onClickCapture, true);

        window.__veilweaverDispose = () => {
            clearInterval(settingsTimer);
            window.removeEventListener('click', onClickCapture, true);
            document.body.classList.remove(BODY_CLASS);
            document.body.style.removeProperty('--vlw-blur');
            document.body.style.removeProperty('--vlw-dim');
            document.getElementById('vlw_settings')?.remove();
            delete window.__veilweaverDispose;
        };
        console.log(`${LOG} готов, вуаль ${settings().enabled ? 'включена' : 'выключена'}.`);
    }

    if (window.jQuery) window.jQuery(init);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
