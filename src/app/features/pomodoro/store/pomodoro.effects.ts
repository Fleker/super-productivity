import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import {
  setCurrentTask,
  toggleStart,
  unsetCurrentTask,
} from '../../tasks/store/task.actions';
import { concatMap, filter, mapTo, switchMap, tap, withLatestFrom } from 'rxjs/operators';
import { PomodoroService } from '../pomodoro.service';
import {
  finishPomodoroSession,
  pausePomodoro,
  skipPomodoroBreak,
  startPomodoro,
  stopPomodoro,
} from './pomodoro.actions';
import { MatDialog } from '@angular/material/dialog';
import { DialogPomodoroBreakComponent } from '../dialog-pomodoro-break/dialog-pomodoro-break.component';
import { Action, select, Store } from '@ngrx/store';
import { selectCurrentTaskId } from '../../tasks/store/task.selectors';
import { EMPTY, Observable, of } from 'rxjs';
import { NotifyService } from '../../../core/notify/notify.service';
import { IS_ELECTRON } from '../../../app.constants';
import { T } from '../../../t.const';
import { SnackService } from '../../../core/snack/snack.service';
import { ElectronService } from '../../../core/electron/electron.service';
import { ipcRenderer } from 'electron';
import { IPC } from '../../../../../electron/ipc-events.const';

@Injectable()
export class PomodoroEffects {
  currentTaskId$: Observable<string | null> = this._store$.pipe(
    select(selectCurrentTaskId),
  );

  playPauseOnCurrentUpdate$: Observable<Action> = createEffect(() =>
    this._pomodoroService.isEnabled$.pipe(
      switchMap((isEnabledI) => of(isEnabledI)),
      filter((isEnabled) => !!isEnabled),
      switchMap((isEnabledI) =>
        this._actions$.pipe(
          ofType(setCurrentTask, unsetCurrentTask),
          withLatestFrom(
            this._pomodoroService.cfg$,
            this._pomodoroService.isBreak$,
            this._pomodoroService.currentSessionTime$,
          ),
          // don't update when on break and stop time tracking is active
          filter(
            ([action, cfg, isBreak, currentSessionTime]) =>
              !isBreak ||
              !cfg.isStopTrackingOnBreak ||
              (isBreak && currentSessionTime <= 0 && action.type === setCurrentTask.type),
          ),
          concatMap(([action, , isBreak, currentSessionTime]) => {
            if ((action as any)?.id && action.type !== unsetCurrentTask.type) {
              if (isBreak && currentSessionTime <= 0) {
                return of(finishPomodoroSession(), startPomodoro());
              }
              return of(startPomodoro());
            } else {
              return of(pausePomodoro({ isBreakEndPause: false }));
            }
          }),
        ),
      ),
    ),
  );

  autoStartNextOnSessionStartIfNotAlready$: Observable<unknown> = createEffect(() =>
    this._pomodoroService.isEnabled$.pipe(
      switchMap((isEnabledI) =>
        !isEnabledI
          ? EMPTY
          : this._actions$.pipe(
              ofType(finishPomodoroSession, skipPomodoroBreak),
              withLatestFrom(this._pomodoroService.isBreak$, this.currentTaskId$),
              filter(([action, isBreak, currentTaskId]) => !isBreak && !currentTaskId),
              mapTo(toggleStart()),
            ),
      ),
    ),
  );

  stopPomodoro$: Observable<unknown> = createEffect(() =>
    this._pomodoroService.isEnabled$.pipe(
      switchMap((isEnabledI) =>
        !isEnabledI
          ? EMPTY
          : this._actions$.pipe(ofType(stopPomodoro), mapTo(unsetCurrentTask())),
      ),
    ),
  );

  pauseTimeTrackingIfOptionEnabled$: Observable<unknown> = createEffect(() =>
    this._pomodoroService.isEnabled$.pipe(
      switchMap((isEnabledI) =>
        !isEnabledI
          ? EMPTY
          : this._actions$.pipe(
              ofType(finishPomodoroSession),
              withLatestFrom(this._pomodoroService.cfg$, this._pomodoroService.isBreak$),
              filter(([action, cfg, isBreak]) => cfg.isStopTrackingOnBreak && isBreak),
              mapTo(unsetCurrentTask()),
            ),
      ),
    ),
  );

  playSessionDoneSoundIfEnabled$: Observable<unknown> = createEffect(
    () =>
      this._pomodoroService.isEnabled$.pipe(
        switchMap((isEnabledI) =>
          !isEnabledI
            ? EMPTY
            : this._actions$.pipe(
                ofType(pausePomodoro, finishPomodoroSession, skipPomodoroBreak),
                withLatestFrom(
                  this._pomodoroService.cfg$,
                  this._pomodoroService.isBreak$,
                ),
                filter(([a, cfg, isBreak]) => {
                  return (
                    ((a.type === finishPomodoroSession.type ||
                      a.type === skipPomodoroBreak.type) &&
                      cfg.isPlaySound &&
                      isBreak) ||
                    (cfg.isPlaySoundAfterBreak && !cfg.isManualContinue && !isBreak) ||
                    (a.type === pausePomodoro.type && a.isBreakEndPause)
                  );
                }),
                tap(() => this._pomodoroService.playSessionDoneSound()),
              ),
        ),
      ),
    { dispatch: false },
  );

  pauseTimeTrackingForPause$: Observable<unknown> = createEffect(() =>
    this._pomodoroService.isEnabled$.pipe(
      switchMap((isEnabledI) =>
        !isEnabledI
          ? EMPTY
          : this._actions$.pipe(
              ofType(pausePomodoro),
              withLatestFrom(this.currentTaskId$),
              filter(([, currentTaskId]) => !!currentTaskId),
              mapTo(unsetCurrentTask()),
            ),
      ),
    ),
  );

  openBreakDialog: Observable<unknown> = createEffect(
    () =>
      this._pomodoroService.isEnabled$.pipe(
        switchMap((isEnabledI) =>
          !isEnabledI
            ? EMPTY
            : this._actions$.pipe(
                ofType(finishPomodoroSession),
                withLatestFrom(this._pomodoroService.isBreak$),
                tap(([action, isBreak]) => {
                  if (isBreak) {
                    this._matDialog.open(DialogPomodoroBreakComponent);
                  }
                }),
              ),
        ),
      ),
    { dispatch: false },
  );

  sessionStartSnack$: Observable<unknown> = createEffect(
    () =>
      this._pomodoroService.isEnabled$.pipe(
        switchMap((isEnabledI) =>
          !isEnabledI
            ? EMPTY
            : this._actions$.pipe(
                ofType(finishPomodoroSession, skipPomodoroBreak),
                withLatestFrom(
                  this._pomodoroService.isBreak$,
                  this._pomodoroService.isManualPause$,
                  this._pomodoroService.currentCycle$,
                ),
                tap(([action, isBreak, isPause, currentCycle]) =>
                  // TODO only notify if window is not currently focused
                  this._notifyService.notifyDesktop({
                    title: isBreak
                      ? T.F.POMODORO.NOTIFICATION.BREAK_X_START
                      : T.F.POMODORO.NOTIFICATION.SESSION_X_START,
                    translateParams: { nr: `${currentCycle + 1}` },
                  }),
                ),
                filter(
                  ([action, isBreak, isPause, currentCycle]) => !isBreak && !isPause,
                ),
                tap(([action, isBreak, isPause, currentCycle]) => {
                  this._snackService.open({
                    ico: 'timer',
                    msg: T.F.POMODORO.NOTIFICATION.SESSION_X_START,
                    translateParams: { nr: `${currentCycle + 1}` },
                  });
                }),
              ),
        ),
      ),
    { dispatch: false },
  );

  setTaskBarIconProgress$: any =
    IS_ELECTRON &&
    createEffect(
      () =>
        this._pomodoroService.isEnabled$.pipe(
          switchMap((isEnabledI) =>
            !isEnabledI ? EMPTY : this._pomodoroService.sessionProgress$,
          ),
          withLatestFrom(this._pomodoroService.isManualPause$),
          // we display pomodoro progress for pomodoro
          tap(([progress, isPause]: [number, boolean]) => {
            const progressBarMode: 'normal' | 'pause' = isPause ? 'pause' : 'normal';
            (this._electronService.ipcRenderer as typeof ipcRenderer).send(
              IPC.SET_PROGRESS_BAR,
              {
                progress,
                progressBarMode,
              },
            );
          }),
        ),
      { dispatch: false },
    );

  constructor(
    private _pomodoroService: PomodoroService,
    private _actions$: Actions,
    private _notifyService: NotifyService,
    private _matDialog: MatDialog,
    private _electronService: ElectronService,
    private _snackService: SnackService,
    private _store$: Store<any>,
  ) {}
}
