from __future__ import print_function

import os.path
import csv
import datetime
import threading
import time
from pylogix.eip import PLC
from pymongo.mongo_client import MongoClient
from pymongo.server_api import ServerApi
from sqlalchemy import create_engine, MetaData, Table

MAX_FILE_CONTENT_LEN = 1
FILE_CONTENTS = []
SQL_PASS = open('../secret/pass.txt', 'r').read()
uri = f"mongodb+srv://padpress1:{SQL_PASS}@cluster0.ywwxl.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
client = MongoClient(uri, server_api=ServerApi('1'))
db = client['press_db']
collection = db['press_data']

def get_press_data():
    tags_lists = ReadFileToStringLists('../MIDIS_DataKeys.txt')
    get_iteratible_tags = Get_String_Lists_To_Iteritable(tags_lists)
    comm = PLC()
    furn_comm = PLC()
    quench_comm = PLC()
    large_oven_comm = PLC()
    comm.IPAddress = "10.0.20.10"
    comm.Route = [(1, 2), (2, '192.168.10.40'), (1, 0)]
    furn_comm.IPAddress = comm.IPAddress
    furn_comm.Route = [(1, 2), (2, '192.168.10.100'), (1, 0)]
    quench_comm.IPAddress = comm.IPAddress		
    large_oven_comm.IPAddress = "10.4.20.93"
    press_path = {'path': comm, 'datas': get_iteratible_tags[0], 'tags': [x[1] for x in get_iteratible_tags[0] if x[3] not in ['array', 'list', 'byteArray']], 'arrayTags': [x[1] for x in get_iteratible_tags[0] if x[3] in ['array', 'list', 'byteArray']]}
    furnace_path = {'path': furn_comm, 'datas': get_iteratible_tags[1], 'tags': [x[1] for x in get_iteratible_tags[1] if x[3] not in ['array', 'list', 'byteArray']], 'arrayTags': [x[1] for x in get_iteratible_tags[1] if x[3] in ['array', 'list', 'byteArray']]}
    quench_path = {'path': quench_comm, 'datas': get_iteratible_tags[2], 'tags': [x[1] for x in get_iteratible_tags[2] if x[3] not in ['array', 'list', 'byteArray']], 'arrayTags': [x[1] for x in get_iteratible_tags[2] if x[3] in ['array', 'list', 'byteArray']]}
    large_oven_path = {'path': large_oven_comm, 'datas': get_iteratible_tags[3], 'tags': [x[1] for x in get_iteratible_tags[3] if x[3] not in ['array', 'list', 'byteArray']], 'arrayTags': [x[1] for x in get_iteratible_tags[3] if x[3] in ['array', 'list', 'byteArray']]}
    plcs = [press_path, furnace_path, quench_path, large_oven_path]
    for plc in plcs:
         t_comm = plc['path']
         tag_list_test = t_comm.GetTagList()
         if tag_list_test.Value == None:
             plcs.remove(plc)
         _=0
    increment_count = 1
    while True:
        try:
            l = []
            for plc_rdr in plcs:
                try:
                    t_comm = plc_rdr['path']
                    t_tags = plc_rdr['tags']
                    if len(plc_rdr['arrayTags']) > 0:
                        for array_tag in plc_rdr['arrayTags']:
                            seek_instr = [x for x in plc_rdr['datas'] if x[1] == array_tag][0]
                            explicit_type = seek_instr[3]
                            if explicit_type == 'array':
                                arr = t_comm.Read(array_tag, int(seek_instr[4]))
                                value_to_keeps = ""
                                for hxd in arr.Value:
                                    hex_string = str(hex(hxd))
                                    bytes_object = bytes.fromhex(hex_string[2:])
                                    ascii_string = bytes_object.decode("ASCII")
                                    value_to_keeps = value_to_keeps + ascii_string
                                l.append({'tagName': array_tag, 'value': str(int(value_to_keeps)) if '-' not in value_to_keeps else value_to_keeps})
                            elif explicit_type == 'list':
                                arr = t_comm.Read(array_tag, int(seek_instr[4]))
                                value_to_keeps = ""
                                for str_vals in arr.Value:
                                    value_to_keeps = value_to_keeps + str(str_vals) + ";"
                                l.append({'tagName': array_tag, 'value': value_to_keeps.rstrip(';')})
                            elif explicit_type == 'byteArr':
                                read = t_comm.Read(array_tag)
                                splitStr = str(read).split('x')[5].rstrip('\\')
                                l.append({'tagName': array_tag, 'value': splitStr})
                    try:
                        tl = t_comm.Read(t_tags)
                        l.extend([{'tagName': x.TagName, 'value': x.Value} for x in tl])
                    except:
                        _=0
                except Exception as e:
                    print(e)
                    _=0
            js_data = GetReadableKeyValueData(l, tags_lists)
            if isinstance(js_data, dict):
                collection.replace_one({}, js_data, upsert=True)
                time.sleep(0.5)
            else:
                raise ValueError('json_data not formatted properly')
        except Exception as e:
            print(f"{datetime.datetime.now().strftime('%m/%d/%Y %H:%M:%S')} - loop error: {e}")
            time.sleep(2)

def WriteLocalCsv(i):
    print('writing csv')
    with open('csvxfer.csv', 'w') as csv_write:
        for line in FILE_CONTENTS:
            csv_write.write(line + '\n')
    if i == MAX_FILE_CONTENT_LEN:
        now = datetime.datetime.now().strftime("%m-%d-%Y_%H")
        fp = "PressData " + now + ".csv"
        arr_to_write = FILE_CONTENTS[1:] if os.path.exists(fp) else FILE_CONTENTS
        with open(fp, 'a') as csv_write:
            for line in arr_to_write:
                csv_write.write(line + '\n')
        return 1
    else:
        return i + 1

def GetReadableKeyValueData(data, instr):
    d = {}
    d['Date/Time'] = datetime.datetime.now().strftime("%m/%d/%Y %H:%M:%S")
    for array_lines in instr:
        try:
            this_data = [x for x in data if x['tagName'] == array_lines[1]][0]
            this_label = array_lines[2]
            this_type = array_lines[3]
            this_scaling = float(array_lines[4])
            this_offset = float(array_lines[5])
            this_value = this_data['value']
            if this_type in ['double', 'int', 'float']:
                if this_type == 'double':
                    save_value = round((this_value / this_scaling) + this_offset, 3)
                else:
                    save_value = round((this_value / this_scaling) + this_offset, 0)
            else:
                save_value = this_value
            d[this_label] = save_value
        except:
            _=0
    return d

def GenerateCsvFromNewData(json_data):
    if len(FILE_CONTENTS) == 0:
        FILE_CONTENTS.append(','.join(list(json_data.keys())))
    else:
        get_values_as_list = ','.join(str(x) for x in list(json_data.values()))
        if len(FILE_CONTENTS) > MAX_FILE_CONTENT_LEN:
            del FILE_CONTENTS[1]
            FILE_CONTENTS.append(get_values_as_list)
        else:
            FILE_CONTENTS.append(get_values_as_list)


def ReadFileToStringLists(fp):
    lists = list()
    with open(fp, 'r', newline='') as file:			
        rdr = csv.reader(file, delimiter='\n')
        for t in rdr:
            sub_list = list()
            line = str(t)
            s_line = line.replace('"', '')
            sp_line = s_line.split(';')
            sub_list.append(sp_line[0].lstrip('[').strip().strip('\''))
            sub_list.append(sp_line[1].strip().strip('\''))
            sub_list.append(sp_line[2].strip().strip('\''))
            sub_list.append(sp_line[3].strip().strip('\''))
            sub_list.append(sp_line[4].strip().strip('\''))
            sub_list.append(sp_line[5].strip().rstrip(']').strip('\''))
            lists.append(sub_list)
    return lists

def Get_String_Lists_To_Iteritable(this_list):
    press_lists = list()
    furnace_lists = list()
    runout_lists = list()
    large_oven_lists = list()
    for x in this_list:
        type = x[0]
        if int(type) == 1:
            press_lists.append(x)
        elif int(type) == 2:
            furnace_lists.append(x)
        elif int(type) == 3:
            runout_lists.append(x)
        elif int(type) == 4:
            large_oven_lists.append(x)
    consolidated_lists = list()
    consolidated_lists.append(press_lists)
    consolidated_lists.append(furnace_lists)
    consolidated_lists.append(runout_lists)
    consolidated_lists.append(large_oven_lists)
    return consolidated_lists

if __name__ == '__main__':
    #drive_folders = get_drive_folders(["Full Current Press Data"])
    #deletionThread = threading.Thread(target=delete_old_data_from_drive, args=['Current_Press_Data_0.csv'])
    #deletionThread.start()
    #while True:
    #    time.sleep(5)
    get_press_data()
    _=0