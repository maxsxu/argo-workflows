import {Page} from 'argo-ui/src/components/page/page';
import {SlidingPanel} from 'argo-ui/src/components/sliding-panel/sliding-panel';
import * as React from 'react';
import {useContext, useEffect, useMemo, useRef, useState} from 'react';
import {RouteComponentProps} from 'react-router-dom';

import {uiUrl} from '../../../shared/base';
import {CostOptimisationNudge} from '../../../shared/components/cost-optimisation-nudge';
import {ErrorNotice} from '../../../shared/components/error-notice';
import {ExampleManifests} from '../../../shared/components/example-manifests';
import {Loading} from '../../../shared/components/loading';
import {PaginationPanel} from '../../../shared/components/pagination-panel';
import {TimestampSwitch} from '../../../shared/components/timestamp';
import {ZeroState} from '../../../shared/components/zero-state';
import {Context} from '../../../shared/context';
import {historyUrl} from '../../../shared/history';
import {ListWatch, sortByYouth} from '../../../shared/list-watch';
import * as models from '../../../shared/models';
import {isArchivedWorkflow, Workflow, WorkflowPhase, WorkflowPhases} from '../../../shared/models';
import * as nsUtils from '../../../shared/namespaces';
import {Pagination, parseLimit} from '../../../shared/pagination';
import {ScopedLocalStorage} from '../../../shared/scoped-local-storage';
import {services} from '../../../shared/services';
import {useCollectEvent} from '../../../shared/use-collect-event';
import useTimestamp, {TIMESTAMP_KEYS} from '../../../shared/use-timestamp';
import * as Actions from '../../../shared/workflow-operations-map';
import {WorkflowCreator} from '../workflow-creator';
import {NAME_FILTER_KEYS, WorkflowFilters, type NameFilterKeys} from '../workflow-filters/workflow-filters';
import {WorkflowsRow} from '../workflows-row/workflows-row';
import {WorkflowsSummaryContainer} from '../workflows-summary-container/workflows-summary-container';
import {WorkflowsToolbar} from '../workflows-toolbar/workflows-toolbar';

import './workflows-list.scss';

interface WorkflowListRenderOptions {
    paginationLimit: number;
    phases: WorkflowPhase[];
    labels: string[];
    name: string;
    namePrefix: string;
    namePattern: string;
}

const actions = Actions.WorkflowOperationsMap;
const allBatchActionsEnabled: Actions.OperationDisabled = {
    RETRY: false,
    RESUBMIT: false,
    SUSPEND: false,
    RESUME: false,
    STOP: false,
    TERMINATE: false,
    DELETE: false
};

const storage = new ScopedLocalStorage('ListOptions');

export function WorkflowsList({match, location, history}: RouteComponentProps<any>) {
    const queryParams = new URLSearchParams(location.search);
    const {navigation} = useContext(Context);

    const isFirstRender = useRef(true);
    const [namespace, setNamespace] = useState(nsUtils.getNamespace(match.params.namespace) || '');
    const [pagination, setPagination] = useState<Pagination>(() => {
        const savedPaginationLimit = storage.getItem('options', {}).paginationLimit || undefined;
        return {
            offset: queryParams.get('offset') || undefined,
            limit: parseLimit(queryParams.get('limit')) || savedPaginationLimit || 50
        };
    });
    const [phases, setPhases] = useState<WorkflowPhase[]>(() => {
        const savedOptions = storage.getItem('options', {});
        // selectedPhases is a legacy name, used here for backward-compat with old storage
        const savedPhases = savedOptions.phases || savedOptions.selectedPhases || [];
        const phaseQueryParam = queryParams.getAll('phase') as WorkflowPhase[];
        return phaseQueryParam.length > 0 ? phaseQueryParam : savedPhases;
    });
    const [labels, setLabels] = useState<string[]>(() => {
        const savedOptions = storage.getItem('options', {});
        // selectedLabels is a legacy name, used here for backward-compat with old storage
        const savedLabels = savedOptions.labels || savedOptions.selectedLabels || [];
        const labelQueryParam = queryParams.getAll('label');
        return labelQueryParam.length > 0 ? labelQueryParam : savedLabels;
    });
    const [createdAfter, setCreatedAfter] = useState<Date>();
    const [finishedBefore, setFinishedBefore] = useState<Date>();
    const [selectedWorkflows, setSelectedWorkflows] = useState(new Map<string, models.Workflow>());
    const [workflows, setWorkflows] = useState<Workflow[]>();
    const [links, setLinks] = useState<models.Link[]>([]);
    const [columns, setColumns] = useState<models.Column[]>([]);
    const [error, setError] = useState<Error>();
    const [nameValue, setNameValue] = useState<string>(() => {
        return queryParams.get(NAME_FILTER_KEYS.find(key => queryParams.get(key))) || '';
    });
    const [nameFilter, setNameFilter] = useState<NameFilterKeys>(() => {
        return NAME_FILTER_KEYS.find(key => queryParams.get(key)) || 'Contains';
    });

    const batchActionDisabled = useMemo<Actions.OperationDisabled>(() => {
        const nowDisabled: any = {...allBatchActionsEnabled};
        for (const action of Object.keys(nowDisabled)) {
            for (const wf of Array.from(selectedWorkflows.values())) {
                nowDisabled[action] = nowDisabled[action] || actions[action].disabled(wf);
            }
        }
        return nowDisabled;
    }, [selectedWorkflows]);

    const counts = countsByCompleted(workflows);

    function clearSelectedWorkflows() {
        setSelectedWorkflows(new Map<string, models.Workflow>());
    }

    function getSidePanel() {
        return queryParams.get('sidePanel');
    }

    // run once on first render
    useEffect(() => {
        (async () => {
            const info = await services.info.getInfo();
            setLinks((info.links || []).filter(link => link.scope === 'workflow-list'));
            setColumns(info.columns);
        })();
    }, []);

    // save history and localStorage
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        // add empty selectedPhases + selectedLabels for forward-compat w/ old version: previous code relies on them existing, so if you move up a version and back down, it breaks
        const options = {selectedPhases: [], selectedLabels: []} as unknown as WorkflowListRenderOptions;
        options.phases = phases;
        options.labels = labels;
        if (pagination.limit) {
            options.paginationLimit = pagination.limit;
        }
        storage.setItem('options', options, {} as WorkflowListRenderOptions);

        const params = new URLSearchParams(history.location.search);
        phases?.forEach(phase => params.append('phase', phase));
        labels?.forEach(label => params.append('label', label));
        if (pagination.offset) {
            params.append('offset', pagination.offset);
        }
        if (pagination.limit) {
            params.append('limit', pagination.limit.toString());
        }
        if (nameValue) {
            params.append(nameFilter, nameValue);
        }
        if (createdAfter) {
            params.append('createdAfter', createdAfter.toISOString());
        }
        if (finishedBefore) {
            params.append('finishedBefore', finishedBefore.toISOString());
        }
        history.push(historyUrl('workflows' + (nsUtils.getManagedNamespace() ? '' : '/{namespace}'), {namespace, extraSearchParams: params}));
    }, [namespace, phases.toString(), labels.toString(), pagination.limit, pagination.offset, nameValue, nameFilter, createdAfter, finishedBefore]); // referential equality, so use values, not refs

    useEffect(() => {
        const listWatch = new ListWatch(
            () => services.workflows.list(namespace, phases, labels, pagination, undefined, nameValue, nameFilter, createdAfter, finishedBefore),
            (resourceVersion: string) => services.workflows.watchFields({namespace, phases, labels, resourceVersion}),
            metadata => {
                setError(null);
                setPagination({...pagination, nextOffset: metadata.continue});
                clearSelectedWorkflows();
            },
            () => setError(null),
            newWorkflows => setWorkflows([...newWorkflows]),
            err => setError(err),
            sortByYouth
        );
        listWatch.start();

        return () => {
            clearSelectedWorkflows();
            listWatch.stop();
        };
    }, [namespace, phases.toString(), labels.toString(), pagination.limit, pagination.offset, nameValue, nameFilter, createdAfter, finishedBefore]); // referential equality, so use values, not refs

    useCollectEvent('openedWorkflowList');

    const [storedDisplayISOFormatStart, setStoredDisplayISOFormatStart] = useTimestamp(TIMESTAMP_KEYS.WORKFLOWS_ROW_STARTED);
    const [storedDisplayISOFormatFinished, setStoredDisplayISOFormatFinished] = useTimestamp(TIMESTAMP_KEYS.WORKFLOWS_ROW_FINISHED);

    return (
        <Page
            title='Workflows'
            toolbar={{
                breadcrumbs: [
                    {title: 'Workflows', path: uiUrl('workflows')},
                    {title: namespace, path: uiUrl('workflows/' + namespace)}
                ],
                actionMenu: {
                    items: [
                        {
                            title: 'Submit New Workflow',
                            iconClassName: 'fa fa-plus',
                            action: () => navigation.goto('.', {sidePanel: 'submit-new-workflow'})
                        },
                        ...links.map(link => ({
                            title: link.name,
                            iconClassName: 'fa fa-external-link',
                            action: () => (window.location.href = link.url)
                        }))
                    ]
                }
            }}>
            <WorkflowsToolbar
                selectedWorkflows={selectedWorkflows}
                clearSelection={clearSelectedWorkflows}
                disabledActions={batchActionDisabled}
                loadWorkflows={clearSelectedWorkflows}
            />
            <div className={`row ${selectedWorkflows.size === 0 ? '' : 'pt-60'}`}>
                <div className='columns small-12 xlarge-2'>
                    <WorkflowsSummaryContainer workflows={workflows} />
                    <div>
                        <WorkflowFilters
                            workflows={workflows || []}
                            namespace={namespace}
                            phaseItems={WorkflowPhases}
                            phases={phases}
                            labels={labels}
                            createdAfter={createdAfter}
                            finishedBefore={finishedBefore}
                            setNamespace={setNamespace}
                            setPhases={setPhases}
                            setLabels={setLabels}
                            setCreatedAfter={(date: Date) => {
                                setCreatedAfter(date);
                                clearSelectedWorkflows(); // date filters are client-side, but clear similar to the server-side ones for consistency
                            }}
                            setFinishedBefore={(date: Date) => {
                                setFinishedBefore(date);
                                clearSelectedWorkflows(); // date filters are client-side, but clear similar to the server-side ones for consistency
                            }}
                            nameFilter={nameFilter}
                            nameValue={nameValue}
                            setNameFilter={setNameFilter}
                            setNameValue={setNameValue}
                        />
                    </div>
                </div>
                <div className='columns small-12 xlarge-10'>
                    <ErrorNotice error={error} />
                    {!workflows ? (
                        <Loading />
                    ) : workflows.length === 0 ? (
                        <ZeroState title='No workflows'>
                            <p>To create a new workflow, use the button above.</p>
                            <p>
                                <ExampleManifests />.
                            </p>
                        </ZeroState>
                    ) : (
                        <>
                            {(counts.complete > 100 || counts.incomplete > 100) && (
                                <CostOptimisationNudge name='workflow-list'>
                                    You have at least {counts.incomplete} incomplete and {counts.complete} complete workflows. Reducing these amounts will reduce your costs.
                                </CostOptimisationNudge>
                            )}
                            <div className='argo-table-list'>
                                <div className='row argo-table-list__head'>
                                    <div className='columns small-1 workflows-list__status'>
                                        <input
                                            type='checkbox'
                                            className='workflows-list__status--checkbox'
                                            checked={workflows.length === selectedWorkflows.size}
                                            onClick={e => {
                                                e.stopPropagation();
                                            }}
                                            onChange={() => {
                                                const newSelections = new Map<string, models.Workflow>();
                                                // Not all workflows are selected, select them all
                                                if (workflows.length !== selectedWorkflows.size) {
                                                    workflows.forEach(wf => newSelections.set(wf.metadata.uid, wf));
                                                }
                                                setSelectedWorkflows(newSelections);
                                            }}
                                        />
                                    </div>
                                    <div className='row small-11'>
                                        <div className='columns small-2'>NAME</div>
                                        <div className='columns small-1'>NAMESPACE</div>
                                        <div className='columns small-1'>
                                            STARTED{' '}
                                            <TimestampSwitch storedDisplayISOFormat={storedDisplayISOFormatStart} setStoredDisplayISOFormat={setStoredDisplayISOFormatStart} />
                                        </div>
                                        <div className='columns small-1'>
                                            FINISHED{' '}
                                            <TimestampSwitch
                                                storedDisplayISOFormat={storedDisplayISOFormatFinished}
                                                setStoredDisplayISOFormat={setStoredDisplayISOFormatFinished}
                                            />
                                        </div>
                                        <div className='columns small-1'>DURATION</div>
                                        <div className='columns small-1'>PROGRESS</div>
                                        <div className='columns small-2'>MESSAGE</div>
                                        <div className='columns small-1'>DETAILS</div>
                                        <div className='columns small-1'>ARCHIVED</div>
                                        {(columns || []).map(col => {
                                            return (
                                                <div className='columns small-1' key={col.key}>
                                                    {col.name}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                                {workflows.map(wf => {
                                    return (
                                        <WorkflowsRow
                                            workflow={wf}
                                            key={wf.metadata.uid}
                                            checked={selectedWorkflows.has(wf.metadata.uid)}
                                            columns={columns}
                                            onChange={key => {
                                                const value = `${key}=${wf.metadata?.labels[key]}`;
                                                let newLabels: string[];
                                                // add or remove the label if it is selected
                                                if (!labels.includes(value)) {
                                                    newLabels = labels.concat(value);
                                                } else {
                                                    newLabels = labels.filter(tag => tag !== value);
                                                }
                                                setLabels(newLabels);
                                            }}
                                            select={() => {
                                                const wfUID = wf.metadata.uid;
                                                if (!wfUID) {
                                                    return;
                                                }
                                                const newSelections = new Map<string, models.Workflow>();
                                                selectedWorkflows.forEach((v, k) => newSelections.set(k, v)); // clone the Map
                                                // add or delete it in the new Map
                                                if (!newSelections.has(wfUID)) {
                                                    newSelections.set(wfUID, wf);
                                                } else {
                                                    newSelections.delete(wfUID);
                                                }
                                                setSelectedWorkflows(newSelections);
                                            }}
                                            displayISOFormatStart={storedDisplayISOFormatStart}
                                            displayISOFormatFinished={storedDisplayISOFormatFinished}
                                        />
                                    );
                                })}
                            </div>
                            <PaginationPanel onChange={setPagination} pagination={pagination} numRecords={(workflows || []).length} />
                        </>
                    )}
                </div>
            </div>
            <SlidingPanel
                isShown={!!getSidePanel()}
                onClose={() => {
                    const qParams: {[key: string]: string | null} = {
                        sidePanel: null
                    };
                    // Remove any lingering query params
                    for (const key of queryParams.keys()) {
                        qParams[key] = null;
                    }
                    // Add back the pagination and namespace params.
                    qParams.limit = pagination.limit.toString();
                    qParams.offset = pagination.offset || null;
                    qParams.namespace = namespace;
                    navigation.goto('.', qParams);
                }}>
                {getSidePanel() === 'submit-new-workflow' && (
                    <WorkflowCreator
                        namespace={nsUtils.getNamespaceWithDefault(namespace)}
                        history={history}
                        onCreate={wf => navigation.goto(uiUrl(`workflows/${wf.metadata.namespace}/${wf.metadata.name}`))}
                    />
                )}
            </SlidingPanel>
        </Page>
    );
}

function countsByCompleted(workflows?: Workflow[]) {
    const counts = {complete: 0, incomplete: 0};
    (workflows || []).forEach(wf => {
        // don't count archived workflows as this is for GC purposes
        if (isArchivedWorkflow(wf)) {
            return;
        }

        if (wf.metadata?.labels?.[models.labels.completed] === 'true') {
            counts.complete++;
        } else {
            counts.incomplete++;
        }
    });
    return counts;
}
