/**
 * mo_app.js — MathOrnament runner for the Gray-Scott wp app.
 *
 * Same pipeline wiring as gray_scott_app.js/runGrayScott(), with one difference:
 * it RETURNS the SymRenderer instance so wrapper UI (share button) can reach
 * ss.getScriptAPI() for param snapshots. The vendored gray_scott_app.js keeps
 * the instance private, which is why this copy exists.
 */

import {
    SymRenderer,
    makeSamplesArray,
    InversiveNavigator,
    GroupMakerFactory,
    ObjectFactory,
} from './modules.js';

import { makePipelineManagerCreator } from '../../../../lib/symhublib/PipelineManager.js';
import { SymmetrizationWorker }       from '../../../../lib/symhublib/SymmetrizationWorker.js';
import { MaskWorker }                 from '../../../../lib/symhublib/MaskWorker.js';

import { GrayScottWorker }      from './GrayScottWorker.js';
import { GrayScottInitializer } from './GrayScottInitializer.js';
import { GrayScottUpgradeData } from './GrayScottUpgradeData.js';

function makeGSWorkerFactory(getGLCtx, getBuffer, getGroup, getChildren) {

    function make(Ctor) {
        return () => {
            const worker = Ctor();
            const ctx = getGLCtx();
            if (ctx) worker.init(ctx);
            const grp = getGroup();
            if (grp && typeof worker.setGroup === 'function') worker.setGroup(grp);
            return worker;
        };
    }

    return ObjectFactory({
        defaultName: 'GrayScottWorker',
        infoArray: [
            { name: 'GrayScottInitializer', label: 'GS initialization', creator: make(GrayScottInitializer) },
            { name: 'GrayScottWorker',      label: 'GS simulation',     creator: make(GrayScottWorker)      },
            { name: 'SymmetrizationWorker', label: 'Symmetrization',    creator: make(SymmetrizationWorker)  },
            { name: 'MaskWorker',           label: 'Mask',              creator: make(MaskWorker)            },
        ],
    });
}

export function runGrayScottApp({ presets, presetsPath, groupName, gridSize = 512, rendererOpts = {} }) {

    const creator = makePipelineManagerCreator({
        gridSize,
        workerFactory: makeGSWorkerFactory,
        defaultWorkers: [
            GrayScottInitializer(),
            GrayScottWorker(),
            SymmetrizationWorker(),
        ],
    });

    // Kept so callers can drive the view directly (the phone UI zooms through
    // navigator.getCanvasTransform(); the wheel path defers to an animation
    // loop that does not tick while the simulation is paused).
    const navigator = new InversiveNavigator();

    const ss = SymRenderer({
        patternCreator:    creator,
        samples:           makeSamplesArray(presets, presetsPath),
        groupMakerFactory: GroupMakerFactory({ defaultName: groupName }),
        navigator:         navigator,
        dataUpgrader:      GrayScottUpgradeData,
        ...rendererOpts,
    });

    ss.run();
    ss.moNavigator = navigator;
    return ss;
}
