interface Config {
  entity: string;
  show_override_if_not_ready?: boolean;
  disable_arm_if_not_ready?: boolean;
  confirm_entities?: string[];
  auto_enter?: {
    code_length: number;
    arm_action: string;
  };
  states?: string[];
  scale?: string;
  show_countdown_timer?: boolean;
  durations?: Record<string, number>;
  title?: string;
  hide_keypad?: boolean;
  style?: string;
  display_letters?: boolean;
  auto_hide?: boolean;
  show_label_ids?: boolean;
  labels?: Record<string, string>;
}

const ICONS = {
  armed_away: "mdi:shield-lock",
  armed_custom_bypass: "mdi:security",
  armed_home: "mdi:shield-home",
  armed_night: "mdi:shield-home",
  disarmed: "mdi:shield-check",
  pending: "mdi:shield-outline",
  triggered: "hass:bell-ring"
};

class AlarmControlPanelCard extends HTMLElement {
  private myhass: any;
  private code_arm_required: boolean = false;
  private has_numeric_code: boolean = false;
  private _config!: Config;
  private _icons: Record<string, string> = ICONS;
  private _entitiesReady: boolean = false;
  private _previousAlarmState: string = "disarmed";
  private _state!: string;
  private _countdownTimerFunction: any | null = null;
  private _timerRadius: number = 30;
  private _timerStrokeWidth: number = this._timerRadius / 5;
  private _timerSize: number = 2 * (this._timerRadius + this._timerStrokeWidth);
  private _currentStateDuration: number = 0;
  private _autoarm_action: string = "";
  private _strokeWidth: number = 0;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  set hass(hass: any) {
    const entity = hass.states[this._config.entity];

    if (entity) {
      this.myhass = hass;
      this.code_arm_required = entity.attributes.code_arm_required;
      this.has_numeric_code =
        !entity.attributes.code_format || entity.attributes.code_format === "number";

      if (!this.shadowRoot?.lastChild) {
        this._createCard();
      }

      const updatedEntitiesReady = this._confirmEntitiesReady();

      if (entity.state !== this._state || this._entitiesReady !== updatedEntitiesReady) {
        this._previousAlarmState = this._state;
        this._state = entity.state;
        this._entitiesReady = updatedEntitiesReady;
        this._updateCardContent();
      }
    }
  }

  _createCard() {
    const config = this._config;

    const card = document.createElement("ha-card");
    card.innerHTML = `
      ${this._iconLabel()}
      ${this._timerCanvas()}
      ${config.title ? '<div id="state-text"></div>' : ""}
    `;

    const content = document.createElement("div");
    content.id = "content";
    content.style.display = config.auto_hide ? "none" : "";
    content.innerHTML = `
      ${this._actionButtons()}
      ${
        this.has_numeric_code
          ? `<ha-textfield id="input-code" label='${this._label(
              "ui.card.alarm_control_panel.code"
            )}' type="password"></ha-textfield>`
          : ""
      }
      ${this._keypad()}
    `;

    card.appendChild(this._style(config.style ?? ""));
    card.appendChild(content);
    this.shadowRoot?.appendChild(card);
    this._showCountdownTimer(false); // start hidden

    this._setupInput();
    this._setupKeypad();
    this._setupActions();
  }

  setConfig(config: Config) {
    if (!config.entity || config.entity.split(".")[0] !== "alarm_control_panel") {
      throw new Error("Please specify an entity from alarm_control_panel domain.");
    }

    if (config.show_override_if_not_ready && !config.disable_arm_if_not_ready) {
      throw new Error(
        "Only specify show_override_if_not_ready if disable_arm_if_not_ready is enabled."
      );
    }

    if (config.disable_arm_if_not_ready && !config.confirm_entities) {
      throw new Error(
        "To use disable_arm_if_not_ready, you must specify a list of confirm_entities."
      );
    }

    if (config.auto_enter) {
      if (!config.auto_enter.code_length || !config.auto_enter.arm_action) {
        throw new Error("Specify both code_length and arm_action when using auto_enter.");
      }
      this._autoarm_action = config.auto_enter.arm_action;
    }

    this._config = Object.assign({}, config);
    if (!this._config.states) this._config.states = ["arm_away", "arm_home"];
    if (!this._config.scale) this._config.scale = "15px";

    const root = this.shadowRoot;
    if (root?.lastChild) {
      root.removeChild(root.lastChild);
    }
  }

  _updateCardContent() {
    const config = this._config;

    if (config.show_countdown_timer && this._previousAlarmState != this._state) {
      // if changing state to arming or pending, and a duration is specified in the config, then start a countdown timer
      if (this._state == "arming" || this._state == "pending") {
        if (this._countdownTimerFunction == null) {
          if (
            this._config.durations &&
            this._config.durations[this._state] &&
            this._config.durations[this._state] != 0
          ) {
            this._currentStateDuration = this._config.durations[this._state];
            this._showCountdownTimer(true);
            this._doCountdownTimer(); // draw once right away
            this._countdownTimerFunction = setInterval(() => this._doCountdownTimer(), 1000);
          }
        }
      } else if (this._countdownTimerFunction) {
        // stop callback, hide timer
        this._showCountdownTimer(false);
        clearInterval(this._countdownTimerFunction);
        this._countdownTimerFunction = null;
      }
    }

    this._updateReady();

    const stateIconEl = this.shadowRoot?.getElementById("state-icon");

    if (stateIconEl) {
      stateIconEl.setAttribute("icon", this._icons[this._state] || "mdi:shield-outline");
    }

    const badgeIconEl = this.shadowRoot?.getElementById("badge-icon");
    if (badgeIconEl) {
      badgeIconEl.className = this._state;
    }

    const iconText = this._stateIconLabel(this._state);
    const iconLabelEl = this.shadowRoot?.getElementById("icon-label");
    const iconTextEl = this.shadowRoot?.getElementById("icon-text");

    if (iconLabelEl && iconTextEl) {
      if (iconText === "") {
        iconLabelEl.style.display = "none";
      } else {
        iconLabelEl.style.display = "";
        if (iconText.length > 5) {
          iconLabelEl.className = "label big";
        } else {
          iconLabelEl.className = "label";
        }
        iconTextEl.innerHTML = iconText;
      }
    }

    const armActionsEl = this.shadowRoot?.getElementById("arm-actions");
    const disarmActionsEl = this.shadowRoot?.getElementById("disarm-actions");

    const armVisible = this._state === "disarmed";
    if (armActionsEl) {
      armActionsEl.style.display = armVisible ? "" : "none";
    }
    if (!config.hide_keypad && this.has_numeric_code) {
      if (disarmActionsEl) {
        disarmActionsEl.style.display = armVisible ? "none" : "";
      }
    }

    if (config.auto_enter) {
      const disarmEl = this.shadowRoot?.getElementById("disarm");

      if (armVisible) {
        if (!config.confirm_entities || !config.disable_arm_if_not_ready || this._entitiesReady)
          this._autoarm_action = config.auto_enter.arm_action;
        else this._autoarm_action = "disabled";
        this.shadowRoot?.querySelectorAll(".actions button").forEach(element => {
          element.classList.remove("autoarm");
          if (element.id === this._autoarm_action) element.classList.add("autoarm");
        });
        if (disarmEl) {
          disarmEl.classList.remove("autoarm");
        }
      } else {
        this._autoarm_action = "disarm";
        if (disarmEl) {
          disarmEl.classList.add("autoarm");
        }
      }
    }

    // hide code and number pad if disarmed, if manual alarm config has code_arm_required=false
    if (!this.code_arm_required) {
      const keypadEl = this.shadowRoot?.getElementById("keypad");
      if (!config.hide_keypad && keypadEl) {
        keypadEl.style.display = armVisible ? "none" : "flex";
      }
      const inputCodeEl = this.shadowRoot?.getElementById("input-code");
      if (this.has_numeric_code && inputCodeEl) {
        inputCodeEl.style.display = armVisible ? "none" : "";
      }
    }
  }

  _showOverrideCheckbox(visible: boolean) {
    const overrideCheckbox = this.shadowRoot?.getElementById("overrideCheckbox") as HTMLFormElement;
    const overrideLabel = this.shadowRoot?.getElementById("overrideLabel") as HTMLLabelElement;
    if (visible) {
      overrideCheckbox.style.visibility = "visible";
      overrideLabel.style.visibility = "visible";
    } else {
      overrideCheckbox.checked = false; // always clear override checkbox when hiding it
      overrideCheckbox.style.visibility = "hidden";
      overrideLabel.style.visibility = "hidden";
    }
  }

  _updateReady() {
    const config = this._config;
    let status: string;

    const state_str = "state.alarm_control_panel." + this._state;
    status = this._label(state_str);

    let showOverrideCheckbox = false;
    if (config.confirm_entities && this._state === "disarmed") {
      if (this._entitiesReady) {
        status = status + " - " + this._label("ready");
        if (config.disable_arm_if_not_ready) {
          this.shadowRoot?.querySelectorAll(".actions button").forEach(element => {
            element.removeAttribute("disabled");
          });
        }
      } else {
        status = status + " - " + this._label("not_ready");
        if (config.disable_arm_if_not_ready) {
          showOverrideCheckbox = config.show_override_if_not_ready ?? false; // this is the only case that shows the override checkbox
          const checkbox = this.shadowRoot?.getElementById("overrideCheckbox") as HTMLFormElement;
          const allowOverride = checkbox.checked;
          if (allowOverride) {
            this.shadowRoot?.querySelectorAll(".actions button").forEach(element => {
              element.removeAttribute("disabled");
            });
          } else {
            this.shadowRoot?.querySelectorAll(".actions button").forEach(element => {
              element.setAttribute("disabled", "true");
            });
          }
        }
      }
    }

    this._showOverrideCheckbox(showOverrideCheckbox);

    if (config.title) {
      const stateTextEl = this.shadowRoot?.getElementById("state-text");
      if (stateTextEl) {
        stateTextEl.innerHTML = status;
        stateTextEl.className = `state ${this._state}`;
      }
    }
  }

  _actionButtons() {
    let disarmButtonIfHideKeypad = "";
    if (this._config.hide_keypad) {
      disarmButtonIfHideKeypad = `<div id="disarm-actions" class="actions">${this._actionButton(
        "disarm"
      )}</div>`;
    }
    return `
      <div id="arm-actions" class="actions">
        ${this._config.states?.map(el => `${this._actionButton(el)}`).join("")}
      </div>
      ${disarmButtonIfHideKeypad}
      <div id="override-option" class="override"><input name="Override" id="overrideCheckbox" type="checkbox" /><label id="overrideLabel" for="override">Override</label></div>`;
  }

  _stateIconLabel(state: string) {
    const stateLabel = state.split("_").pop();
    if (stateLabel === "disarmed" || stateLabel === "triggered" || !stateLabel) return "";
    return stateLabel;
  }

  _iconLabel() {
    return `
      <ha-label-badge-icon id="badge-icon">
        <div class="badge-container" id="badge-container">
          <div class="label-badge" id="badge">
            <div class="value">
              <ha-icon id="state-icon"/>
            </div>
            <div class="label" id="icon-label">
              <span id="icon-text"/>
            </div>
          </div>
        </div>
    </ha-label-badge-icon>`;
  }

  _timerCanvas() {
    // radius 30.  strokewidth = radius/4. width = 2*radius + strokewidth * 2
    if (this._config.show_countdown_timer) {
      return `
        <countdown-timer id='countdown'>
          <canvas id="timerCanvas" width="${this._timerSize}" height="${this._timerSize}">
            <span id="countdown-text" role="status"></span>
          </canvas>
        </countdown-timer>`;
    }
    return "";
  }
  _actionButton(state: string) {
    return `<button outlined id="${state}">
      ${this._label("ui.card.alarm_control_panel." + state)}</button>`;
  }

  _doCountdownTimer() {
    const nowTime = new Date().getTime();
    const timeMadeActive = new Date(this.myhass.states[this._config.entity].last_changed).getTime();
    const elapsedSeconds = (nowTime - timeMadeActive) / 1000;
    const durationSeconds = this._currentStateDuration;
    const timeRemaining = Math.round(Math.max(durationSeconds - elapsedSeconds, 0));
    const elapsedPercent = elapsedSeconds / durationSeconds;

    const canvas = this.shadowRoot?.getElementById("timerCanvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.lineWidth = this._timerStrokeWidth;
    ctx.clearRect(0, 0, this._timerSize, this._timerSize);

    const centerPos = this._timerSize / 2;
    if (elapsedPercent > 0.75) ctx.fillStyle = "red";
    else if (elapsedPercent > 0.5) ctx.fillStyle = "orange";
    else ctx.fillStyle = "#8ac575";

    // draw filled center circle
    ctx.beginPath();
    ctx.arc(centerPos, centerPos, this._timerRadius, 0, 2 * Math.PI, false);
    ctx.fill();

    // draw arc around edges counter-clockwise from top-center 1.5*pi to 3.5*pi
    const endAngle = 3.5 * Math.PI - 2 * Math.PI * elapsedPercent;
    ctx.beginPath();
    ctx.arc(centerPos, centerPos, this._timerRadius, 1.5 * Math.PI, endAngle, false);
    ctx.strokeStyle = "#477050";
    ctx.stroke();

    // draw text label
    const fontSize = this._timerRadius / 1.2;
    ctx.font = "700 " + fontSize + "px sans-serif";
    ctx.lineWidth = this._strokeWidth;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "white";
    ctx.fillText(`${timeRemaining}`, this._timerSize / 2, this._timerSize / 2);
  }

  _setupActions() {
    const config = this._config;

    if (config.auto_hide) {
      const badgeIconEl = this.shadowRoot?.getElementById("badge-icon");
      if (badgeIconEl) {
        const contentEl = this.shadowRoot?.getElementById("content");

        badgeIconEl.addEventListener("click", () => {
          if (contentEl) {
            if (contentEl.style.display === "none") {
              contentEl.style.display = "";
            } else {
              contentEl.style.display = "none";
            }
          }
        });
      }
    }

    this.shadowRoot?.querySelectorAll(".actions button").forEach(element => {
      // note- disarm button is handled in _setupKeypad
      element.addEventListener("click", () => {
        const inputEl = this.shadowRoot?.querySelector("ha-textfield") as HTMLFormElement;

        const value = inputEl ? inputEl.value : "";
        this._callService(element.id, value);
      });
    });

    this.shadowRoot?.getElementById("overrideCheckbox")?.addEventListener("change", () => {
      this._updateReady();
    });
  }

  _callService(service: string, code: string) {
    const input = this.shadowRoot?.querySelector("ha-textfield") as HTMLFormElement;
    this.myhass.callService("alarm_control_panel", `alarm_${service}`, {
      entity_id: this._config.entity,
      code: code
    });
    if (input) {
      input.value = "";
    }
  }

  _showCountdownTimer(show: boolean) {
    const countdownEL = this.shadowRoot?.getElementById("countdown");
    const badgeIconEl = this.shadowRoot?.getElementById("badge-icon");
    if (this._config.show_countdown_timer) {
      if (countdownEL) {
        countdownEL.style.display = show ? "" : "none";
      }
    } else {
      show = false;
    }
    if (badgeIconEl) {
      badgeIconEl.style.display = show ? "none" : "";
    }
  }

  _setupInput() {
    if (this._config.auto_enter) {
      const input = this.shadowRoot?.querySelector("ha-textfield") as HTMLFormElement;
      input?.addEventListener("input", () => {
        this._autoEnter();
      });
    }
  }

  _setupKeypad() {
    const input = this.shadowRoot?.querySelector("ha-textfield") as HTMLFormElement;
    this.shadowRoot?.querySelectorAll(".pad button").forEach(element => {
      if (element.getAttribute("value") === this._label("ui.card.alarm_control_panel.clear_code")) {
        element.addEventListener("click", () => {
          input.value = "";
        });
      } else if (element.id === "disarm") {
        element.addEventListener("click", () => {
          this._callService("disarm", input.value);
        });
      } else {
        element.addEventListener("click", () => {
          input.value += element.getAttribute("value");
          this._autoEnter();
        });
      }
    });
  }

  _autoEnter() {
    if (this._config.auto_enter) {
      const input = this.shadowRoot?.querySelector("ha-textfield") as HTMLFormElement;
      const code = input.value;
      if (
        code.length == this._config.auto_enter.code_length &&
        this._autoarm_action != "disabled"
      ) {
        this._callService(this._autoarm_action, code);
      }
    }
  }

  _keypad() {
    if (this._config.hide_keypad || !this.has_numeric_code) return "";

    return `
      <div id="keypad" class="pad">
        <div>
          ${this._keypadButton("1", "")}
          ${this._keypadButton("4", "GHI")}
          ${this._keypadButton("7", "PQRS")}
          ${this._keypadButton(this._label("ui.card.alarm_control_panel.clear_code"), "", "clear")}
        </div>
        <div>
          ${this._keypadButton("2", "ABC")}
          ${this._keypadButton("5", "JKL")}
          ${this._keypadButton("8", "TUV")}
          ${this._keypadButton("0", "")}
        </div>
        <div>
          ${this._keypadButton("3", "DEF")}
          ${this._keypadButton("6", "MNO")}
          ${this._keypadButton("9", "WXYZ")}
          <div id="disarm-actions">${this._actionButton("disarm")}</div>
        </div>
      </div>`;
  }

  _confirmEntitiesReady() {
    if (!this._config.confirm_entities) return true;
    for (let i = 0; i < this._config.confirm_entities.length; i++) {
      if (this.myhass.states[this._config.confirm_entities[i]].state != "off") return false;
    }
    return true;
  }

  _keypadButton(button: string, alpha: string, id = "") {
    let letterHTML = "";
    if (this._config.display_letters) {
      letterHTML = `<div class='alpha'>${alpha}</div>`;
    }
    if (id == "") id = button;
    return `<button id="key${id}" value="${button}">${button}${letterHTML}</button>`;
  }

  _style(icon_style: string) {
    const style = document.createElement("style");
    style.textContent = `
      ha-card {
        position: relative;
        padding-bottom: 32px;
        --alarm-color-disarmed: var(--label-badge-green);
        --alarm-color-pending: var(--label-badge-yellow);
        --alarm-color-triggered: var(--label-badge-red);
        --alarm-color-armed: var(--label-badge-red);
        --alarm-color-autoarm: rgba(0, 153, 255, .1);
        --alarm-state-color: var(--alarm-color-armed);
        --base-unit: ${this._config.scale};
        font-size: calc(var(--base-unit));
        ${icon_style}
      }
      ha-icon {
        color: var(--alarm-state-color);
        width: 24px;
        height: 24px;
      }
      countdown-timer {
        position: absolute;
        right: 12px;
        top: 12px;
      }
      ha-label-badge-icon {
        --ha-label-badge-color: var(--alarm-state-color);
        --label-badge-text-color: var(--alarm-state-color);
        --label-badge-background-color: var(--paper-card-background-color);
        color: var(--alarm-state-color);
        position: absolute;
        right: 12px;
        top: 12px;
      }
      .badge-container {
        display: inline-block;
        text-align: center;
        vertical-align: top;
      }
      .label-badge {
        position: relative;
        display: block;
        margin: 0 auto;
        width: var(--ha-label-badge-size, 2.5em);
        text-align: center;
        height: var(--ha-label-badge-size, 2.5em);
        line-height: var(--ha-label-badge-size, 2.5em);
        font-size: var(--ha-label-badge-font-size, 1.5em);
        border-radius: 50%;
        border: 0.1em solid var(--ha-label-badge-color, var(--primary-color));
        color: var(--label-badge-text-color, rgb(76, 76, 76));
        white-space: nowrap;
        background-color: var(--label-badge-background-color, white);
        background-size: cover;
        transition: border 0.3s ease-in-out;
      }
      .label-badge .value {
        font-size: 90%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .label-badge .value.big {
        font-size: 70%;
      }
      .label-badge .label {
        position: absolute;
        bottom: -1em;
        /* Make the label as wide as container+border. (parent_borderwidth / font-size) */
        left: -0.2em;
        right: -0.2em;
        line-height: 1em;
        font-size: 0.5em;
      }
      .label-badge .label span {
        box-sizing: border-box;
        max-width: 100%;
        display: inline-block;
        background-color: var(--ha-label-badge-color, var(--primary-color));
        color: var(--ha-label-badge-label-color, white);
        border-radius: 1em;
        padding: 9% 16% 8% 16%; /* mostly apitalized text, not much descenders => bit more top margin */
        font-weight: 500;
        overflow: hidden;
        text-transform: uppercase;
        text-overflow: ellipsis;
        transition: background-color 0.3s ease-in-out;
        text-transform: var(--ha-label-badge-label-text-transform, uppercase);
      }
      .label-badge .label.big span {
        font-size: 90%;
        padding: 10% 12% 7% 12%; /* push smaller text a bit down to center vertically */
      }
      .badge-container .title {
        margin-top: 1em;
        font-size: var(--ha-label-badge-title-font-size, 0.9em);
        width: var(--ha-label-badge-title-width, 5em);
        font-weight: var(--ha-label-badge-title-font-weight, 400);
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: normal;
      }
      .disarmed {
        --alarm-state-color: var(--alarm-color-disarmed);
      }
      .triggered {
        --alarm-state-color: var(--alarm-color-triggered);
        animation: pulse 1s infinite;
      }
      .arming {
        --alarm-state-color: var(--alarm-color-pending);
        animation: pulse 1s infinite;
      }
      .pending {
        --alarm-state-color: var(--alarm-color-pending);
        animation: pulse 1s infinite;
      }
      ha-textfield {
        display: block;
        text-align: center;
        margin: auto;
        max-width: 150px;
        --mdc-typography-subtitle1-font-size: 24px;
      }
      .state {
        margin-left: 20px;
        font-size: calc(var(--base-unit) * 1);
        position: relative;
        bottom: 16px;
        color: var(--alarm-state-color);
        animation: none;
      }
      .pad {
        display: flex;
        justify-content: center;
      }
      .pad div {
        display: flex;
        flex-direction: column;
      }
      .pad button {
        position: relative;
        padding: calc(var(--base-unit)*0.5);
        font-size: calc(var(--base-unit) * 1.6);
        font-weight: 700;
        width: calc(var(--base-unit) * 8);
        height: calc(var(--base-unit) * 5);
        margin: 8px;
        background-color: var(--primary-background-color);
        border-width: 2px;
        border-style: solid;
        border-color: var(--primary-color);
        border-radius: 4px;
        #color: var(--primary-color);
        color: var(--primary-text-color);
      }
      .pad .autoarm {
        background: var(--alarm-color-autoarm) !important;
      }

      .pad button:focus {
        border-color: var(--dark-primary-color);
        outline: none;
      }
      .pad button#disarm {
        border-color: var(--primary-text-color);
        background-color: var(--primary-color);
        font-size: calc(var(--base-unit) * 1.1);
      }
      .pad button#keyclear {
        border-color: red;
        font-size: calc(var(--base-unit) * 1.1);
        background-color: var(--primary-background-color);
      }
      .actions {
        margin: 0 8px;
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        font-size: calc(var(--base-unit) * 1);
      }
      .override {
        margin-top: 12px;
        text-align: center;
        font-size: calc(var(--base-unit) * 1.2);
      }
      .override label {
        padding-left: 4px;
      }
      .actions button {
        font-size: calc(var(--base-unit) * 1.5);
        font-weight: 700;
        width: calc(var(--base-unit) * 11);
        height: calc(var(--base-unit) * 6);
        margin-top: 0px;
        margin-right: 12px;
        margin-bottom: 0px;
        margin-left: 12px;
        border-width: 2px;
        border-style: solid;
        border-color: var(--primary-text-color);
        background-color: var(--primary-color);
        color: var(--primary-text-color);
      }
      button:disabled,
      button[disabled] {
        background-color: #cccccc;
        color: #666666;
      }
      .actions .autoarm {
        background: var(--alarm-color-autoarm) !important;
      }
      button#disarm {
        color: var(--google-red-500);
      }
      .alpha {
        position: absolute;
        text-align: center;
        bottom: calc(var(--base-unit) * 0.1);
        color: var(--secondary-text-color);
        font-size: calc(var(--base-unit) * 0.7);
      }
    `;
    return style;
  }

  _label(label: string, default_label = undefined) {
    // Just show "raw" label; useful when want to see underlying const
    // so you can define your own label.
    if (this._config.show_label_ids) return label;

    if (this._config.labels && this._config.labels[label]) return this._config.labels[label];

    const lang = this.myhass.selectedLanguage || this.myhass.language;
    const translations = this.myhass.resources[lang];
    if (translations && translations[label]) return translations[label];

    if (default_label) return default_label;

    // If all else fails then prettify the passed in label const
    const last_bit = label.split(".").pop();
    return last_bit
      ?.split("_")
      .join(" ")
      .replace(/^\w/, c => c.toUpperCase());
  }

  getCardSize() {
    return 1;
  }
}

customElements.define("alarm_control_panel-card", AlarmControlPanelCard);
