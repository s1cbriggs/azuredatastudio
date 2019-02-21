/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { NodeInfo } from 'sqlops';
import { TreeItem, TreeItemCollapsibleState } from 'vscode';
import * as nls from 'vscode-nls';
const localize = nls.loadMessageBundle();

import { TreeNode } from './treeNode';
import { CmsResourceService } from './resourceService';

export class CmsResourceResourceTreeNode extends TreeNode {
	public constructor(
		public readonly resourceNodeWithProviderId: any,
		parent: TreeNode
	) {
		super();

		this.parent = parent;
	}

	public async getChildren(): Promise<TreeNode[]> {
		// It is a leaf node.
		if (this.resourceNodeWithProviderId.resourceNode.treeItem.collapsibleState === TreeItemCollapsibleState.None) {
			return <TreeNode[]>[];
		}

		try {
			const children = await this._resourceService.getChildren(this.resourceNodeWithProviderId.resourceProviderId, this.resourceNodeWithProviderId.resourceNode);

			if (children.length === 0) {
				return [];
			} else {
				return children.map((child) => {
					// To make tree node's id unique, otherwise, treeModel.js would complain 'item already registered'
					child.resourceNode.treeItem.id = `${this.resourceNodeWithProviderId.resourceNode.treeItem.id}.${child.resourceNode.treeItem.id}`;
					return new CmsResourceResourceTreeNode(child, this);
				});
			}
		} catch (error) {
			return [];
		}
	}

	public getTreeItem(): TreeItem | Promise<TreeItem> {
		return this._resourceService.getTreeItem(this.resourceNodeWithProviderId.resourceProviderId, this.resourceNodeWithProviderId.resourceNode);
	}

	public getNodeInfo(): NodeInfo {
		const treeItem = this.resourceNodeWithProviderId.resourceNode.treeItem;

		return {
			label: treeItem.label,
			isLeaf: treeItem.collapsibleState === TreeItemCollapsibleState.None ? true : false,
			errorMessage: undefined,
			metadata: undefined,
			nodePath: this.generateNodePath(),
			nodeStatus: undefined,
			nodeType: treeItem.contextValue,
			nodeSubType: undefined,
			iconType: treeItem.contextValue
		};
	}

	public get nodePathValue(): string {
		return this.resourceNodeWithProviderId.resourceNode.treeItem.id;
	}

	private _resourceService = CmsResourceService.getInstance();

	private static readonly noResourcesLabel = localize('cms.resource.resourceTreeNode.noResourcesLabel', 'No Resources found.');
}