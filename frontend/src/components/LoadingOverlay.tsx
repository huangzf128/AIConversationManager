import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './LoadingOverlay.css';

class OverlayBuilder {
  private _visible = false;
  private _text = '';
  private _spinner = true;

  visible(v: boolean) {
    this._visible = v;
    return this;
  }

  text(t: string) {
    this._text = t;
    return this;
  }

  spinner(s: boolean) {
    this._spinner = s;
    return this;
  }

  build(): ReactNode {
    if (!this._visible) return null;
    return createPortal(
      <div className="loading-overlay">
        {this._spinner && <div className="loading-overlay-spinner" />}
        {this._text && <span className="loading-overlay-text">{this._text}</span>}
      </div>,
      document.body,
    );
  }
}

export const LoadingOverlay = {
  builder: () => new OverlayBuilder(),
};
