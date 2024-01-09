/*
 * RERO angular core
 * Copyright (C) 2020-2024 RERO
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import {
  Component,
  ElementRef,
  Input,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild,
} from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import { FormlyJsonschema } from '@ngx-formly/core/json-schema';
import { TranslateService } from '@ngx-translate/core';
import { BsModalRef, BsModalService } from 'ngx-bootstrap/modal';
import { NgxSpinnerService } from 'ngx-spinner';
import { ToastrService } from 'ngx-toastr';
import { Observable, of, Subscription } from 'rxjs';
import { catchError, map, switchMap, tap } from 'rxjs/operators';
import { DialogService } from '../../dialog/dialog.service';
import { ActionStatus } from '../action-status';
import { orderedJsonSchema, removeEmptyValues } from '../editor/utils';
import { File as RecordFile } from '../record';
import { RecordUiService } from '../record-ui.service';
import { RecordService } from '../record.service';
import { FilesService } from './files.service';
@Component({
  selector: 'ng-core-record-files',
  templateUrl: './files.component.html',
})
export class RecordFilesComponent implements OnDestroy, OnInit {
  // Record PID.
  @Input()
  pid: string;

  // Type of resource.
  @Input()
  type: string;

  // List of files for the record.
  files: Array<RecordFile> = [];

  // Current managed file
  currentFile: RecordFile = null;

  // Files list to upload, currently limited to one, but can be multiple.
  filesToUpload: FileList = null;

  // Form modal reference.
  formModalRef: BsModalRef;

  // Wether API raise an error or not.
  hasError = false;

  // File key to add
  fileKey: string;

  // Record data
  record: any;

  // Object containing data to build the metadata editor.
  metadataForm: {
    fields: Array<any>;
    model: any;
    form: any;
  } = {
    fields: [],
    model: null,
    form: null,
  };

  // Fields not to display in metadata info.
  infoExcludedFields = [
    'key',
    'bucket',
    'checksum',
    'file_id',
    'size',
    'version_id'
  ];

  // Observable resolving if files metadata can be updated.
  canAdd: ActionStatus = { can: false, message: '' };

  // Configuration for record type.
  private config: any;

  // Subscriptions to observables.
  private subscriptions: Subscription = new Subscription();

  // Default max file size in Mb.
  private defaultMaxSize = 500;

  // Reference on file input, used to reset value
  @ViewChild('file', { read: ElementRef })
  fileInput: ElementRef;

  @ViewChild('formModal')
  formModalTemplate: TemplateRef<any>;

  @ViewChild('metadataFormModal')
  metadataFormModalTemplate: TemplateRef<any>;

  /**
   * Constructor.
   *
   * @param fileService FilesService.
   * @param dialogService Dialog service.
   * @param translateService Translate service.
   * @param toastrService Toastr service.
   * @param spinner Spinner service.
   * @param modalService Modal service.
   * @param recordService Record service.
   * @param recordUiService Record UI service.
   * @param formlyJsonschema JSON schema for formly.
   */
  constructor(
    private fileService: FilesService,
    private dialogService: DialogService,
    private translateService: TranslateService,
    private toastrService: ToastrService,
    private spinner: NgxSpinnerService,
    private modalService: BsModalService,
    private recordService: RecordService,
    private recordUiService: RecordUiService,
    private formlyJsonschema: FormlyJsonschema
  ) {}

  /**
   * Component initialization.
   *
   * Retrieve files from record
   */
  ngOnInit() {
    // Load configuration
    this.config = this.recordUiService.getResourceConfig(this.type);

    // Configures properties that are not displayed in information.
    if (this.config.files.infoExcludedFields) {
      this.infoExcludedFields = this.infoExcludedFields.concat(
        this.config.files.infoExcludedFields
      );
    }

    this.spinner.show();

    // Load files
    this._getFiles$().subscribe(() => {
      this.spinner.hide();
    });

    // Load JSON schema and initialize form.
    this.recordService
      .getSchemaForm(this.type)
      .subscribe((jsonSchema: any) => {
        if (jsonSchema.schema.properties._files) {
          this.metadataForm.form = new UntypedFormGroup({});
          this.metadataForm.fields = [
            this.formlyJsonschema.toFieldConfig(
              orderedJsonSchema(jsonSchema.schema.properties._files.items),
              {
                map: (field: any, schema: any) => {
                  if (schema.form && schema.form.expressions) {
                    field.expressions = schema.form.expressions;
                  }
                  return field;
                },
              }
            ),
          ];
        }
      });

    // Process when modal is hidden
    this.subscriptions.add(
      this.modalService.onHide.subscribe((reason: string | any) => {
        this.hideForm();
      })
    );
  }

  /**
   * Component destruction
   *
   * Unsubscribe from all subscriptions.
   */
  ngOnDestroy() {
    this.subscriptions.unsubscribe();
  }

  /**
   * Delete a file.
   *
   * @param file File object to delete
   */
  deleteFile(file: RecordFile) {
    this.dialogService
      .show({
        ignoreBackdropClick: true,
        initialState: {
          title: this.translateService.instant('Confirmation'),
          body: this.translateService.instant(
            'Do you really want to remove this file?'
          ),
          confirmButton: true,
          confirmTitleButton: this.translateService.instant('OK'),
          cancelTitleButton: this.translateService.instant('Cancel'),
        },
      })
      .pipe(
        switchMap((confirm: boolean) => {
          if (confirm === true) {
            this.spinner.hide();

            return this.fileService
              .delete(this.type, this.pid, file.key, file.version_id)
              .pipe(map(() => true));
          }
          return of(false);
        })
      )
      .subscribe((removed: boolean) => {
        if (removed === true) {
          this._getFiles$().subscribe(() => {
            this.spinner.hide();
            this.toastrService.success(
              this.translateService.instant('File removed successfully.')
            );
          });
        }
      });
  }

  /**
   * Determine if the file is displayed in the list, as children are hidden by
   * default.
   *
   * @param file Record file.
   * @returns true if file has to be displayed.
   */
  showItem(file: RecordFile): boolean {
    if (file.is_head === true) {
      return true;
    }

    const found = this.files.find((item: RecordFile) => {
      return (
        item.key === file.key &&
        item.is_head === true &&
        item.showChildren === true
      );
    });

    return found !== undefined;
  }

  /**
   * Determine if the file has old versions.
   *
   * @param file Record file.
   * @returns true if file has old version.
   */
  hasChildren(file: RecordFile): boolean {
    if (file.is_head === false) {
      return false;
    }

    const sameFiles = this.files.filter(
      (item: RecordFile) => item.key === file.key
    );

    return sameFiles.length > 1;
  }

  /**
   * Show form inside the modal.
   */
  showForm() {
    this.formModalRef = this.modalService.show(this.formModalTemplate);
  }

  /**
   * Hide the modal.
   */
  hideForm() {
    if (this.metadataForm.model) {
      this._getFiles$().subscribe(() => {
        this.metadataForm.model = null;
      });
    }
    this.formModalRef.hide();
  }

  /**
   * When file input is changed, new FileList is stored for preparing the upload.
   *
   * @param fileList List of file to upload.
   */
  handleFileInput(fileList: FileList) {
    this.filesToUpload = fileList;
    this.fileKey = this.filesToUpload[0].name;
  }

  /**
   * Upload files
   */
  upload() {
    // Iterate over FileList object to process each files.
    Array.from(this.filesToUpload).forEach((file) => {
      this.spinner.show();

      try {
        if (file.size > this.defaultMaxSize * 1000 * 1000) {
          throw new Error(`The maximum size for a file is ${this.defaultMaxSize}Mb, ${file.name} cannot be uploaded.`);
        }

        const reader = new FileReader();

        // This method is called when file is finished to read in client side.
        reader.onload = () => {
          // Update or create a new file
          const fileName = this.currentFile
            ? this.currentFile.key
            : this.fileKey;

          this.fileService
            .put(this.type, this.pid, fileName, file)
            .subscribe(() => {
              this.hideForm();

              this.toastrService.success(
                this.translateService.instant('File uploaded successfully.')
              );

              this._getFiles$().subscribe(() => {
                this.spinner.hide();
              });
            });
        };

        // Begin file read.
        reader.readAsBinaryString(file);
      } catch (error) {
        this.spinner.hide();
        this.toastrService.error(
          this.translateService.instant(error.message)
        );
      }
    });
  }

  /**
   * Store current file to manage and show upload form.
   *
   * @param file File object to manage, when adding a new file, this value is `null`.
   */
  manageFile(file: RecordFile) {
    this.currentFile = file;
    this.showForm();
    this.resetForm();
  }

  /**
   * Reset file input and list of files to upload.
   */
  resetForm() {
    if (this.fileInput) {
      this.fileInput.nativeElement.value = '';
    }
    this.filesToUpload = null;
  }

  /**
   * Return the URL of the file.
   *
   * @param file File object.
   * @returns URL of the file.
   */
  getFileUrl(file: RecordFile): string {
    return this.fileService.getUrl(this.type, this.pid, file.key);
  }

  /**
   * Edition of metadata for the given file.
   *
   * @param file File object.
   * @returns void
   */
  editMetadataFile(file: RecordFile): void {
    if (!file.metadata) {
      return;
    }

    // Set the model
    this.metadataForm.model = file.metadata;

    // Show modal
    this.formModalRef = this.modalService.show(this.metadataFormModalTemplate);
  }

  /**
   * Save file's metadata.
   *
   * @returns void
   */
  saveMetadata(): void {
    // Check if form has errors
    this.metadataForm.form.updateValueAndValidity();

    // Show a message if form has errors.
    if (this.metadataForm.form.valid === false) {
      this.toastrService.error(
        this.translateService.instant('The form contains errors.')
      );
      return;
    }

    this.spinner.show();

    // Clean empty data
    this.record._files = removeEmptyValues(this.record._files);

    // Update record
    this.recordService
      .update(this.type, this.pid, this.record)
      .pipe(
        switchMap(() => {
          return this._getFiles$();
        })
      )
      .subscribe(() => {
        this.spinner.hide();
        this.hideForm();
        this.toastrService.success(
          this.translateService.instant(
            'Metadata have been saved successfully.'
          )
        );
      });
  }

  /**
   * Observable for loading record and files.
   *
   * @returns Observable emitting files
   */
  private _getFiles$(): Observable<any> {
    return this.recordService.getRecord(this.type, this.pid).pipe(
      switchMap((record: any) => {
        this.record = record.metadata;
        return this.fileService.list(this.type, this.pid);
      }),
      tap((files) => {
        files = files.map((item: RecordFile) => {
          // By default, show info about the file.
          item.showInfo = true;
          item.url = this.getFileUrl(item);

          // By default, hide other versions of the file.
          item.showChildren = false;

          // Store metadata (retrieved from record).
          item.metadata = this._getFilesMetadata(item.key);
          return item;
        });

        // If set in config, apply the function for filtering files.
        if (this.config.files && this.config.files.filterList) {
          files = files.filter(this.config.files.filterList);
        }

        // If set in config, apply the function for filtering files.
        if (this.config.files && this.config.files.orderList) {
          files.sort(this.config.files.orderList);
        }

        this.files = files;
       }),
       tap(() => {
          // Check if a file can be added.
          const canAdd$ = this.config.files.canAdd
            ? this.config.files.canAdd()
            : of({ can: false, message: '' });
          this.subscriptions.add(
            canAdd$.subscribe((result: ActionStatus) => this.canAdd = result)
          );
       }),
      catchError(() => {
        this.hasError = true;
        return of([]);
      })
    );
  }

  /**
   * Get files metadata corresponding to file key, stored in record.
   *
   * @param fileKey File key.
   * @returns Metadata object for the file.
   */
  private _getFilesMetadata(fileKey: string): any {
    if (!this.record._files) {
      return null;
    }

    // Get metadata stored in record.
    const metadata = this.record._files.filter(
      (item: any) => fileKey === item.key
    );

    return metadata.length > 0 ? metadata[0] : null;
  }
}
