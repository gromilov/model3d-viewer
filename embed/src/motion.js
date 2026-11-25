/**
 * Camera motion: a turntable, and a sequence of your own views.
 *
 * Two things, because they answer two different questions a person asks of a
 * print. A turntable answers "what does this look like from everywhere" and needs
 * no setup at all. A sequence of views answers "show me these three corners in
 * this order, slowly" -- the shot someone wants for a listing, a handover or a
 * message, and the one thing a turntable cannot do.
 *
 * The design decisions that matter:
 *
 *   - **A view is a whole camera**: angle, distance and shift. Storing the angle
 *     alone would fly between corners while leaving the zoom wherever the last
 *     view put it, which looks like the model changing size for no reason.
 *   - **Interpolation is eased, not linear**, and the easing is applied across the
 *     whole path rather than between each pair. Linear motion starts and stops
 *     with a jolt, and per-segment easing makes a three-view tour pulse at every
 *     corner instead of flowing round it.
 *   - **The turntable turns the camera, not the model.** Rotating the mesh would
 *     take the build plate and the lighting with it, and a preview whose key light
 *     swings around is telling you something untrue about the material.
 *   - **Nothing here runs on a timer of its own**: one step function is driven from
 *     the same frame-with-watchdog schedule the player uses, so a background tab
 *     cannot leave a loop spinning.
 */

import { append, clear, el, icon, placePopover } from './dom.js';

/** Shortest sensible tour, in milliseconds. */
export const MIN_DURATION = 800;

/** Longest, so a typo cannot make a tour that appears to hang. */
export const MAX_DURATION = 60000;

/** The shortest gap between two views in a tour. */
export const MIN_HOLD = 0;

/**
 * Ease a fraction of a tour.
 *
 * Smoothstep: zero velocity at both ends, which is what makes a sequence of still
 * views feel like a camera move rather than a slideshow. Applied to the whole path
 * rather than per segment -- see the note at the top of the file.
 *
 * @param t - progress through the tour, 0..1.
 * @returns the eased progress, 0..1.
 */
export function easeTour(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Interpolate two angles the short way round.
 *
 * A yaw of 350° to 10° is a 20° turn, not a 340° one, and takeing the long way is
 * the classic way an orbit animation looks broken at one particular angle. The
 * same function covers pitch, which is clamped short of the poles and so never
 * wraps.
 *
 * @param from - start angle, radians.
 * @param to - end angle, radians.
 * @param t - 0..1.
 */
export function lerpAngle(from, to, t) {
  const full = Math.PI * 2;
  let delta = (to - from) % full;
  if (delta > Math.PI) delta -= full;
  if (delta < -Math.PI) delta += full;
  return from + delta * t;
}

/** Linear interpolation, for the parts of a camera that do not wrap. */
export function lerp(from, to, t) {
  return from + (to - from) * t;
}

/**
 * Blend two cameras.
 *
 * @param from - the starting camera.
 * @param to - the ending camera.
 * @param t - 0..1.
 * @returns a camera of the same shape `setCamera` accepts.
 */
export function blendCamera(from, to, t) {
  const panFrom = Array.isArray(from.pan) ? from.pan : [0, 0, 0];
  const panTo = Array.isArray(to.pan) ? to.pan : [0, 0, 0];
  return {
    yaw: lerpAngle(from.yaw, to.yaw, t),
    pitch: lerp(from.pitch, to.pitch, t),
    zoom: lerp(from.zoom, to.zoom, t),
    pan: [0, 1, 2].map((index) => lerp(panFrom[index], panTo[index], t)),
  };
}

/**
 * The camera a tour shows at a given moment.
 *
 * A tour of one view has no segment to interpolate, so it holds that view; the
 * caller does not have to special-case it.
 *
 * @param views - the recorded cameras, in order.
 * @param duration - the whole tour, in milliseconds.
 * @param elapsed - how far in, in milliseconds.
 * @returns `{ camera, index }` where `index` is the view being approached.
 */
export function sampleTour(views, duration, elapsed) {
  if (!Array.isArray(views) || views.length === 0) return null;
  if (views.length === 1) return { camera: views[0], index: 0 };
  const span = Math.max(1, duration);
  const progress = easeTour(elapsed / span);
  const segments = views.length - 1;
  const position = progress * segments;
  const index = Math.min(segments - 1, Math.floor(position));
  const local = Math.min(1, Math.max(0, position - index));
  return {
    camera: blendCamera(views[index], views[index + 1], local),
    index: local >= 0.5 ? index + 1 : index,
  };
}

/**
 * Whether a value is a camera this module can fly to.
 *
 * Deliberately loose about the optional parts: a view recorded before zoom and pan
 * existed still has an angle, and refusing it would throw away a tour that works.
 */
export function isCamera(value) {
  return typeof value === 'object' && value !== null
    && Number.isFinite(value.yaw) && Number.isFinite(value.pitch);
}

/**
 * The motion controls: one popover holding the turntable and the tour.
 *
 * Built once per panel and reused, like the colour window, and for the same
 * reason: it is a handful of nodes whose values are rewritten on open, and
 * rebuilding it would drop the pointer capture of a drag in progress.
 */
export class MotionControl {
  /**
   * @param t - the panel's translator.
   * @param document - the document to create nodes in.
   * @param host - the positioned element to mount into.
   * @param callbacks - `onSpin`, `onTour`, `onStop`, `onRecord`, `onForget`,
   *   `onDuration`, `onCapture`. Each is a plain notification of intent; this
   *   class owns no camera and no clock.
   */
  constructor({ t, document, host, callbacks }) {
    this.t = t;
    this.document = document;
    this.callbacks = callbacks;
    this.open = false;
    /** The views in the tour, as the panel currently has them. */
    this.views = [];
    this.build();
    append(host, this.node);
  }

  /** Whether the popover is showing. */
  get isOpen() {
    return this.open;
  }

  /* ------------------------------------------------------------------ DOM -- */

  build() {
    // The turntable: one switch and a speed, since a turntable needs nothing else.
    this.spinToggle = el('button', {
      type: 'button',
      class: 'm3d-motion-toggle',
      'aria-pressed': 'false',
      onClick: () => this.callbacks.onSpin?.(),
    }, [
      el('span', { class: 'm3d-motion-toggle-label' }, this.t('motion.spin')),
      el('span', { class: 'm3d-motion-toggle-state' }, this.t('motion.off')),
    ]);

    this.spinSpeed = el('input', {
      type: 'range',
      min: '0.15',
      max: '1.2',
      step: '0.05',
      class: 'm3d-motion-speed',
      'aria-label': this.t('motion.speed'),
      onInput: (event) => this.callbacks.onSpeed?.(Number(event.target.value)),
    });
    this.spinSpeed.value = '0.4';

    this.spinSpeedValue = el('span', { class: 'm3d-motion-value' }, '0.4');

    // The tour: a list of recorded views, in order.
    this.viewList = el('div', { class: 'm3d-motion-views', 'data-motion-views': true });
    this.viewCount = el('span', { class: 'm3d-motion-count' });

    this.recordButton = el('button', {
      type: 'button',
      class: 'm3d-motion-button',
      title: this.t('motion.record'),
      onClick: () => this.callbacks.onRecord?.(),
    }, [icon('plus', 13), el('span', null, this.t('motion.record'))]);

    this.playButton = el('button', {
      type: 'button',
      class: 'm3d-motion-button is-primary',
      title: this.t('motion.playTour'),
      onClick: () => this.callbacks.onTour?.(),
    }, [icon('play', 13), el('span', null, this.t('motion.playTour'))]);

    this.stopButton = el('button', {
      type: 'button',
      class: 'm3d-motion-button',
      title: this.t('motion.stop'),
      onClick: () => this.callbacks.onStop?.(),
    }, [icon('pause', 13), el('span', null, this.t('motion.stop'))]);

    this.durationField = el('input', {
      type: 'text',
      class: 'm3d-motion-number',
      inputmode: 'numeric',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': this.t('motion.duration'),
      onInput: (event) => {
        const text = event.target.value.trim();
        if (!/^\d{1,5}$/.test(text)) return;
        this.callbacks.onDuration?.(Number(text));
      },
    });
    this.durationField.value = '4000';

    this.title = el('span', { class: 'm3d-motion-title' }, this.t('motion.title'));

    this.window = el('div', {
      class: 'm3d-motion-window',
      role: 'dialog',
      'aria-label': this.t('motion.title'),
      tabindex: '-1',
      onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); this.hide(); } },
    }, [
      el('div', { class: 'm3d-motion-head' }, [
        this.title,
        el('button', {
          type: 'button',
          class: 'm3d-motion-icon',
          title: this.t('picker.cancel'),
          'aria-label': this.t('picker.cancel'),
          onClick: () => this.hide(),
        }, icon('close', 12)),
      ]),
      el('div', { class: 'm3d-motion-section' }, [
        this.spinToggle,
        el('div', { class: 'm3d-motion-row' }, [
          el('span', { class: 'm3d-motion-label' }, this.t('motion.speed')),
          this.spinSpeed,
          this.spinSpeedValue,
        ]),
      ]),
      el('div', { class: 'm3d-motion-section' }, [
        el('div', { class: 'm3d-motion-row is-head' }, [
          el('span', { class: 'm3d-motion-label' }, this.t('motion.views')),
          this.viewCount,
        ]),
        this.viewList,
        el('div', { class: 'm3d-motion-row' }, [this.recordButton]),
        el('div', { class: 'm3d-motion-row' }, [
          el('span', { class: 'm3d-motion-label' }, this.t('motion.duration')),
          this.durationField,
          el('span', { class: 'm3d-motion-unit' }, this.t('motion.ms')),
        ]),
        el('div', { class: 'm3d-motion-row' }, [this.playButton, this.stopButton]),
      ]),
    ]);

    this.node = el('div', {
      class: 'm3d-motion',
      'data-model3d-motion': true,
      hidden: true,
    }, [this.window]);
  }

  /* ----------------------------------------------------------------- open -- */

  /**
   * Open the popover.
   *
   * @param anchor - the button that opened it, so it appears beside that control.
   * @param state - `{ spinning, speed, views, duration, playing }`.
   */
  show(anchor, state) {
    this.anchor = anchor;
    this.update(state);
    this.node.hidden = false;
    this.open = true;
    this.node.style.left = '8px';
    this.node.style.top = '8px';
    // Placed after it is visible: a hidden element measures zero.
    this.place();
    this.window.focus?.();
  }

  /** Position the popover against its button. */
  place() {
    placePopover(this.node, this.anchor);
  }

  /** Close the popover. */
  hide() {
    if (!this.open) return;
    this.open = false;
    this.node.hidden = true;
  }

  /* ---------------------------------------------------------------- state -- */

  /**
   * Rewrite the window from the panel's state.
   *
   * Called on open and after every change the panel makes, so the two never
   * disagree about whether the turntable is running or how many views a tour has.
   */
  update(state) {
    const { spinning = false, speed = 0.4, views = [], duration = 4000, playing = false } = state;
    this.views = views;
    this.spinToggle.classList.toggle('is-on', spinning);
    this.spinToggle.setAttribute('aria-pressed', String(spinning));
    this.spinToggle.querySelector('.m3d-motion-toggle-state').textContent = spinning
      ? this.t('motion.on')
      : this.t('motion.off');
    if (this.document.activeElement !== this.spinSpeed) this.spinSpeed.value = String(speed);
    this.spinSpeedValue.textContent = Number(speed).toFixed(2);
    if (this.document.activeElement !== this.durationField) {
      this.durationField.value = String(Math.round(duration));
    }
    this.playButton.disabled = views.length < 1;
    this.stopButton.disabled = !playing;
    this.playButton.classList.toggle('is-playing', playing);
    this.renderViews();
  }

  /** Rebuild the view list. */
  renderViews() {
    clear(this.viewList);
    const count = this.views.length;
    this.viewCount.textContent = this.t('motion.viewCount', { count: String(count) });
    this.viewList.hidden = count === 0;
    if (count === 0) {
      this.viewList.append(el('p', { class: 'm3d-motion-empty' }, this.t('motion.noViews')));
      this.viewList.hidden = false;
      return;
    }
    this.views.forEach((view, index) => {
      const row = el('div', { class: 'm3d-motion-view' }, [
        el('span', { class: 'm3d-motion-view-index' }, String(index + 1)),
        el('button', {
          type: 'button',
          class: 'm3d-motion-view-go',
          title: this.t('motion.goTo'),
          onClick: () => this.callbacks.onGoTo?.(index),
        }, this.describe(view)),
        el('button', {
          type: 'button',
          class: 'm3d-motion-icon',
          title: this.t('motion.forget'),
          'aria-label': this.t('motion.forget'),
          onClick: () => this.callbacks.onForget?.(index),
        }, icon('trash', 12)),
      ]);
      this.viewList.append(row);
    });
  }

  /** One view as a short readable line: its angle, distance and shift. */
  describe(view) {
    const degrees = (radians) => `${Math.round((radians * 180) / Math.PI)}°`;
    const zoom = Number.isFinite(view.zoom) ? `${view.zoom.toFixed(2)}×` : '1.00×';
    return `${degrees(view.yaw)} / ${degrees(view.pitch)} · ${zoom}`;
  }
}
