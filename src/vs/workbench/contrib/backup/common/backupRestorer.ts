/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IResourceInput } from 'vs/platform/editor/common/editor';
import { Schemas } from 'vs/base/common/network';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { IUntitledTextResourceInput, IEditorInput } from 'vs/workbench/common/editor';
import { toLocalResource, isEqual } from 'vs/base/common/resources';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';

export class BackupRestorer implements IWorkbenchContribution {

	// {{SQL CARBON EDIT}}
	private static readonly SQLQUERY_REGEX = /SQLQuery\d+/;
	private static readonly UNTITLED_REGEX = /Untitled-\d+/;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IBackupFileService private readonly backupFileService: IBackupFileService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService
	) {
		this.restoreBackups();
	}

	private restoreBackups(): void {
		this.lifecycleService.when(LifecyclePhase.Restored).then(() => this.doRestoreBackups());
	}

	protected async doRestoreBackups(): Promise<URI[] | undefined> {

		// Find all files and untitled with backups
		const backups = await this.backupFileService.getBackups();
		const unresolvedBackups = await this.doResolveOpenedBackups(backups);

		// Some failed to restore or were not opened at all so we open and resolve them manually
		if (unresolvedBackups.length > 0) {
			await this.doOpenEditors(unresolvedBackups);

			return this.doResolveOpenedBackups(unresolvedBackups);
		}

		return undefined;
	}

	private async doResolveOpenedBackups(backups: URI[]): Promise<URI[]> {
		const unresolvedBackups: URI[] = [];

		await Promise.all(backups.map(async backup => {
			const openedEditor = this.findEditorByResource(backup);
			if (openedEditor) {
				try {
					await openedEditor.resolve(); // trigger load
				} catch (error) {
					unresolvedBackups.push(backup); // ignore error and remember as unresolved
				}
			} else {
				unresolvedBackups.push(backup);
			}
		}));

		return unresolvedBackups;
	}

	private findEditorByResource(resource: URI): IEditorInput | undefined {
		for (const editor of this.editorService.editors) {
			if (isEqual(editor.resource, resource)) {
				return editor;
			}
		}

		return undefined;
	}

	private async doOpenEditors(resources: URI[]): Promise<void> {
		const hasOpenedEditors = this.editorService.visibleEditors.length > 0;
		const inputs = resources.map((resource, index) => this.resolveInput(resource, index, hasOpenedEditors));

		// Open all remaining backups as editors and resolve them to load their backups
		await this.editorService.openEditors(inputs);
	}

	private resolveInput(resource: URI, index: number, hasOpenedEditors: boolean): IResourceInput | IUntitledTextResourceInput {
		const options = { pinned: true, preserveFocus: true, inactive: index > 0 || hasOpenedEditors };

		// this is a (weak) strategy to find out if the untitled input had
		// an associated file path or not by just looking at the path. and
		// if so, we must ensure to restore the local resource it had.
		if (resource.scheme === Schemas.untitled && !BackupRestorer.UNTITLED_REGEX.test(resource.path) && BackupRestorer.SQLQUERY_REGEX.test(resource.path)) { // {{SQL CARBON EDIT}} @anthonydresser add sql regex test
			return { resource: toLocalResource(resource, this.environmentService.configuration.remoteAuthority), options, forceUntitled: true };
		}

		return { resource, options };
	}
}
