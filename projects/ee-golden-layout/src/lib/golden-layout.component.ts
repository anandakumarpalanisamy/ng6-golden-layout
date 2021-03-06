import {
  isDevMode,
  ComponentFactoryResolver,
  ComponentFactory,
  HostListener,
  ViewContainerRef,
  ElementRef,
  Component,
  OnInit,
  OnDestroy,
  ApplicationRef,
  Type,
  Input,
  Optional,
  Inject,
  NgZone,
  InjectionToken,
  Injector,
  ViewChild,
} from '@angular/core';
import * as GoldenLayout from 'golden-layout';

import { GlOnResize, GlOnShow, GlOnHide, GlOnTab, GlOnClose } from './hooks';
import {
  GoldenLayoutService,
  ComponentInitCallbackFactory,
  ComponentInitCallback
} from './golden-layout.service';
import {
  FallbackComponent,
  FailedComponent,
} from './fallback';

export const GoldenLayoutContainer = new InjectionToken('GoldenLayoutContainer');
export const GoldenLayoutComponentState = new InjectionToken('GoldenLayoutComponentState');
/**
 * Type guard which determines if a component implements the GlOnResize interface.
 */
function implementsGlOnResize(obj: any): obj is GlOnResize {
  return typeof obj === 'object' && typeof obj.glOnResize === 'function';
}

/**
 * Type guard which determines if a component implements the GlOnShow interface.
 */
function implementsGlOnShow(obj: any): obj is GlOnShow {
  return typeof obj === 'object' && typeof obj.glOnShow === 'function';
}

/**
 * Type guard which determines if a component implements the GlOnHide interface.
 */
function implementsGlOnHide(obj: any): obj is GlOnHide {
  return typeof obj === 'object' && typeof obj.glOnHide === 'function';
}

/**
 * Type guard which determines if a component implements the GlOnTab interface.
 */
function implementsGlOnTab(obj: any): obj is GlOnTab {
  return typeof obj === 'object' && typeof obj.glOnTab === 'function';
}

/**
 * Type guard which determines if a component implements the GlOnClose interface.
 */
function implementsGlOnClose(obj: any): obj is GlOnClose {
  return typeof obj === 'object' && typeof obj.glOnClose === 'function';
}

class Deferred<T> {
  public promise: Promise<T>
  public resolve: (val?: T) => void;
  public reject: (err: any) => void;
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    })
  }
}

const COMPONENT_REF_KEY = '$componentRef';

@Component({
  selector: 'golden-layout-root',
  styles: [`
    .ng-golden-layout-root {
      width:100%;
      height:100%;
    }`
  ],
  template: `<div class="ng-golden-layout-root" #glroot></div>`
})
export class GoldenLayoutComponent implements OnInit, OnDestroy, ComponentInitCallbackFactory {
  private goldenLayout: GoldenLayout;
  private topWindow: Window;
  private isChildWindow: boolean;
  private unloaded = false;
  private onUnloaded = new Deferred<void>();
  private fallbackType: ComponentInitCallback = null;
  @ViewChild('glroot') private el: ElementRef;

  constructor(private glService: GoldenLayoutService,
              private viewContainer: ViewContainerRef,
              private appref: ApplicationRef,
              private componentFactoryResolver: ComponentFactoryResolver,
              private ngZone: NgZone,
              private readonly injector: Injector,
              @Optional() @Inject(FallbackComponent) private readonly fallbackComponent: any) {
    this.topWindow = glService.getRootWindow();
    this.isChildWindow = glService.isChildWindow();
    if (!!fallbackComponent) {
      this.fallbackType = this.createComponentInitCallback(fallbackComponent);
    }
    if (this.isChildWindow) {
      window.document.title = window.document.URL;
      (console as any).__log = console.log;
      console.log = this.topWindow.console.log;
    }
    if (isDevMode()) console.log(`Create@${this.isChildWindow ? 'child' : 'root'}!`);
  }

  public ngOnInit(): void {
    if (isDevMode()) console.log(`Init@${this.isChildWindow ? 'child' : 'root'}!`);
    let anyWin = this.topWindow as any;
    if (!this.isChildWindow) {
      anyWin.__apprefs = [];
      anyWin.__injector = this.injector;
    }

    // attach the application reference to the root window, save the original 'tick' method
    anyWin.__apprefs.push(this.appref);
    (this.appref as any).__tick = this.appref.tick;

    this.appref.tick = (): void => {
      for (const ar of (this.topWindow as any).__apprefs) {
        ar._zone.run(() => ar.__tick());
      }
    };

    this.glService.getState().then((layout: any) => {
      this._createLayout(layout);
    });
  }

  public ngOnDestroy(): void {
    if (isDevMode()) console.log(`Destroy@${this.isChildWindow ? 'child' : 'root'}!`);
    if (this.isChildWindow) {
      console.log = (console as any).__log;
    }
    this.unloaded = true;
    // restore the original tick method.
    // this appens in two cases:
    // either the window is closed, after that it's not important to restore the tick method
    // or within the root window, where we HAVE to restore the original tick method
    this.appref.tick = (this.appref as any).__tick;
  }

  @HostListener('window:beforeunload')
  public unloadHandler(): void {
    if (isDevMode()) console.log(`Unload@${this.isChildWindow ? 'child' : 'root'}`);
    if (this.unloaded) {
      return;
    }
    this.onUnloaded.resolve();
    this.unloaded = true;
    if (this.isChildWindow) { // if the top window is unloaded, the whole application is destroyed.
      const index = (this.topWindow as any).__apprefs.indexOf(this.appref);
      (this.topWindow as any).__apprefs.splice(index, 1);
    }
  }

  private _createLayout(layout: any): void {
    this.goldenLayout = new GoldenLayout(layout, $(this.el.nativeElement));
    this.goldenLayout.getComponent = (type) => {
      const component = (this.goldenLayout as any)._components[type] || this.fallbackType;
      if (!component) {
        throw new Error(`Unknown component "${type}"`);
      }
      return component;
    };
    // Register all golden-layout components.
    this.glService.initialize(this.goldenLayout, this);

    // Initialize the layout.
    this.goldenLayout.init();
  }

  @HostListener('window:resize', ['$event'])
  public onResize(event: any): void {
    if (this.goldenLayout) {
      this.goldenLayout.updateSize();
    }
  }

  public createComponentInitCallback(componentType: Type<any>): ComponentInitCallback {
    // Can't use an ES6 lambda here, since it is not a constructor
    const self = this;
    return function (container: GoldenLayout.Container, componentState: any) {
      self.ngZone.run(() => {
        // Create an instance of the angular component.
        const factory = self.componentFactoryResolver.resolveComponentFactory(componentType);
        let failedComponent: string = null;
        if (componentType === self.fallbackComponent) {
          // Failed to find the component constructor **AND** we have a fallback component defined,
          // so lookup the failed component's name and inject it into the fallback component.
          failedComponent = (container as any)._config.componentName;
        }
        const injector = self._createComponentInjector(container, componentState, failedComponent);
        const componentRef = self.viewContainer.createComponent(factory, undefined, injector);

        // Bind the new component to container's client DOM element.
        container.getElement().append($(componentRef.location.nativeElement));
        self._bindEventHooks(container, componentRef.instance);
        let destroyed = false;
        container.on('destroy', () => {
          if (destroyed) {
            return;
          }
          destroyed = true;
          $(componentRef.location.nativeElement).remove();
          componentRef.destroy();
        });
        self.onUnloaded.promise.then(() => {
          if (destroyed) {
            return;
          }
          destroyed = true;
          $(componentRef.location.nativeElement).remove();
          componentRef.destroy();
        });
      });
    };
  }

  /**
   * Creates an injector capable of injecting the GoldenLayout object,
   * component container, and initial component state.
   */
  private _createComponentInjector(
    container: GoldenLayout.Container,
    componentState: any,
    failed: string | null,
  ): Injector {
    const providers = [
      {
        provide: GoldenLayoutContainer,
        useValue: container
      },
      {
        provide: GoldenLayoutComponentState,
        useValue: componentState
      },
      {
        provide: GoldenLayout,
        useValue: this.goldenLayout
      },
    ];
    if (!!failed) {
      providers.push({
        provide: FailedComponent,
        useValue: failed,
      });
    }
    return Injector.create(providers, this.injector);
  }

  /**
   * Registers an event handler for each implemented hook.
   * @param container Golden Layout component container.
   * @param component Angular component instance.
   */
  private _bindEventHooks(container: GoldenLayout.Container, component: any): void {
    if (implementsGlOnResize(component)) {
      container.on('resize', () => {
        component.glOnResize();
      });
    }

    if (implementsGlOnShow(component)) {
      container.on('show', () => {
        component.glOnShow();
      });
    }

    if (implementsGlOnHide(component)) {
      container.on('hide', () => {
        component.glOnHide();
      });
    }

    if (implementsGlOnTab(component)) {
      container.on('tab', (tab) => {
        component.glOnTab(tab);
      });
    }

    if (implementsGlOnClose(component)) {
      let hookEstablished = false;
      container.on('tab', (tab) => {
        /* GoldenLayout SHOULD send a tabEvent when the component is placed within a tab control, giving
           us access to the tab object, which allows us to patch the close handler to actually call the
           right close option.
        */
        if (hookEstablished) {
          return;
        }
        hookEstablished = true;
        tab.closeElement.off('click');
        const originalClose = tab._onCloseClick.bind(tab);
        tab._onCloseClick = (ev) => {
          ev.stopPropagation();
          tab.contentItem.container.close();
        };
        tab._onCloseClickFn = tab._onCloseClick.bind(tab);
        tab.closeElement.click(tab._onCloseClickFn);
      });

      const containerClose = container.close.bind(container);
      container.close = () => {
        console.log("Container close:", container);
        if (!(container as any)._config.isClosable) {
          return false;
        }
        component.glOnClose().then(() => {
          containerClose();
        }, () => { /* Prevent close, don't care about rejections */ });
      };
    }
  }
}
